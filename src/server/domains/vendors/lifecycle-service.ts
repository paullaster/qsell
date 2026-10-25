import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { reasonCodes, vendorBankAccounts, vendorEvents, vendors, type VendorBlock, type VendorStatus } from '@/server/db/drizzle/schema';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorLedgerService } from '@/server/domains/finance/payables/vendor-ledger-service';
import type { VendorNotifier } from './notifier';

export const VENDOR_STANDING = 'vendor_standing';

/** Why a vendor is paused, blocked or archived; a company adds its own under the same use. */
const STANDING_REASONS = [
  { code: 'VENDOR_COMPLIANCE', description: 'A compliance document is missing or expired', requiresComment: false },
  { code: 'VENDOR_PERFORMANCE', description: 'Poor delivery or quality', requiresComment: true },
  { code: 'VENDOR_DISPUTE', description: 'An open dispute with the vendor', requiresComment: true },
  { code: 'VENDOR_FRAUD_SUSPECTED', description: 'Suspected fraud or an unverified change to payment details', requiresComment: true },
  { code: 'VENDOR_AT_REQUEST', description: 'The vendor asked us to', requiresComment: false },
  { code: 'VENDOR_OTHER', description: 'Another reason (explain)', requiresComment: true },
] as const;

/** The states a vendor cannot be moved out of by these actions because a review is still open. */
const IN_REVIEW: VendorStatus[] = ['profile_submitted', 'under_review'];

export interface Standing {
  status: VendorStatus;
  block: VendorBlock;
  /** The reason on the last suspension, block or archive, for the screen. */
  reasonCode: string | null;
  reasonText: string | null;
  since: string | null;
}

/**
 * Suspending, blocking and archiving a vendor (design doc §6.2). Each needs a reason from the list, is written to the vendor's
 * history, and is undone by its own action. `blocked_payment` stops payments but not documents; `blocked_all` stops both
 * (Business Central's Blocked field). Archiving is refused while the vendor is owed money, owes a review or has a bank change open.
 */
export class VendorLifecycleService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ledger: Pick<VendorLedgerService, 'balances'>,
    private readonly reasons: ReasonCodes,
    private readonly notify?: VendorNotifier,
  ) {}

  async ensureReasons(companyId: string): Promise<void> {
    await this.db
      .insert(reasonCodes)
      .values(STANDING_REASONS.map((r) => ({ companyId, code: r.code, description: r.description, requiresComment: r.requiresComment, appliesTo: [VENDOR_STANDING], isSystem: true })))
      .onConflictDoNothing({ target: [reasonCodes.companyId, reasonCodes.code] });
  }

  private async checked(ctx: FinanceContext, reason: { code: string; text?: string | null }) {
    await this.ensureReasons(ctx.companyId);
    return await this.reasons.require(ctx.companyId, reason, VENDOR_STANDING);
  }

  private async change(
    ctx: FinanceContext,
    vendorId: string,
    event: string,
    allowed: (v: { status: VendorStatus; block: VendorBlock }) => string | null,
    apply: (v: { status: VendorStatus; block: VendorBlock }) => { status?: VendorStatus; block?: VendorBlock },
    reason: { code: string; text: string | null } | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [v] = await tx.select({ status: vendors.status, block: vendors.block }).from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId))).for('update');
      if (v === undefined) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
      const refusal = allowed(v);
      if (refusal !== null) throw new FinanceError('NOT_ALLOWED', refusal);
      const next = apply(v);
      await tx.update(vendors).set({ ...next, updatedAt: new Date() }).where(eq(vendors.id, vendorId));
      await tx.insert(vendorEvents).values({
        vendorId,
        event,
        fromStatus: v.status,
        toStatus: next.status ?? v.status,
        reasonCode: reason?.code ?? null,
        reasonText: reason?.text ?? null,
        data: { blockFrom: v.block, blockTo: next.block ?? v.block },
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        origin: { ...ctx.origin },
      });
    });
  }

  async suspend(ctx: FinanceContext, vendorId: string, reason: { code: string; text?: string | null }): Promise<void> {
    const r = await this.checked(ctx, reason);
    await this.change(ctx, vendorId, 'suspended', (v) => (v.status === 'active' ? null : 'Only an active vendor can be suspended.'), () => ({ status: 'suspended' }), r);
    await this.notify?.suspended(vendorId, r.text ?? STANDING_REASONS.find((x) => x.code === r.code)?.description ?? 'See the buyer');
  }

  async reinstate(ctx: FinanceContext, vendorId: string): Promise<void> {
    await this.change(ctx, vendorId, 'reinstated', (v) => (v.status === 'suspended' ? null : 'Only a suspended vendor can be reinstated.'), () => ({ status: 'active' }), null);
  }

  /** Sets what is blocked: nothing, payments only, or everything. */
  async setBlock(ctx: FinanceContext, vendorId: string, block: VendorBlock, reason: { code: string; text?: string | null }): Promise<void> {
    if (!(['none', 'payment', 'all'] as string[]).includes(block)) throw new FinanceError('INVALID', 'Choose what to block.');
    const r = block === 'none' ? null : await this.checked(ctx, reason);
    await this.change(
      ctx,
      vendorId,
      block === 'none' ? 'unblocked' : 'blocked',
      (v) => {
        if (v.status === 'archived') return 'An archived vendor cannot be blocked.';
        if (v.block === block) return block === 'none' ? 'This vendor is not blocked.' : 'The vendor is already blocked this way.';
        return null;
      },
      () => ({ block }),
      r,
    );
  }

  async archive(ctx: FinanceContext, vendorId: string, reason: { code: string; text?: string | null }): Promise<void> {
    const r = await this.checked(ctx, reason);
    const balances = await this.ledger.balances(ctx.companyId, vendorId);
    if (balances.some((b) => b.cents !== 0)) throw new FinanceError('OPEN_BALANCE', 'This vendor is still owed money, or owes us. Settle the account first.');
    const [pending] = await this.db.select({ id: vendorBankAccounts.id }).from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, vendorId), inArray(vendorBankAccounts.status, ['pending_change']))).limit(1);
    if (pending !== undefined) throw new FinanceError('BANK_CHANGE_OPEN', 'A bank-detail change is waiting. Decide it first.');
    await this.change(
      ctx,
      vendorId,
      'archived',
      (v) => {
        if (v.status === 'archived') return 'This vendor is already archived.';
        return IN_REVIEW.includes(v.status) ? 'Decide the application first.' : null;
      },
      () => ({ status: 'archived' }),
      r,
    );
  }

  /** An archived vendor comes back as suspended, so nothing is bought from it until someone checks and reinstates it. */
  async restore(ctx: FinanceContext, vendorId: string): Promise<void> {
    await this.change(ctx, vendorId, 'restored', (v) => (v.status === 'archived' ? null : 'Only an archived vendor can be restored.'), () => ({ status: 'suspended' }), null);
  }

  /** The current standing and the reason behind it, for the vendor card. */
  async standing(companyId: string, vendorId: string): Promise<Standing | null> {
    const [v] = await this.db.select({ status: vendors.status, block: vendors.block }).from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, vendorId)));
    if (v === undefined) return null;
    const [last] = await this.db
      .select({ reasonCode: vendorEvents.reasonCode, reasonText: vendorEvents.reasonText, at: vendorEvents.createdAt })
      .from(vendorEvents)
      .where(and(eq(vendorEvents.vendorId, vendorId), inArray(vendorEvents.event, ['suspended', 'blocked', 'archived'])))
      .orderBy(desc(vendorEvents.id))
      .limit(1);
    const marked = v.status === 'suspended' || v.status === 'archived' || v.block !== 'none';
    return { ...v, reasonCode: marked ? (last?.reasonCode ?? null) : null, reasonText: marked ? (last?.reasonText ?? null) : null, since: marked ? (last?.at.toISOString() ?? null) : null };
  }
}
