import { and, desc, eq, inArray, isNotNull, lte, ne } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vendorBankAccounts, vendorDocuments, vendorDocumentTypes, vendorEvents, vendors } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkBanks, type BankInput } from '@/lib/vendor-profile';
import { addBusinessDays } from '@/lib/vendor-schedule';
import { encryptCredentials, fingerprintSecret } from '@/server/domains/payments/crypto';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorNotifier } from './notifier';
import { ProfileError, type PortalActor } from './profile-service';

/** Working days between approval and the day a new account may receive money (design doc §17.2). */
export const BANK_COOL_OFF_DAYS = 3;
const MAX_ACCOUNTS = 5;

export type BankChangeStage = 'awaiting_callback' | 'awaiting_approval' | 'cooling_off';

/** Where a pending change stands, from what has been recorded about it. */
export function bankChangeStage(row: { callbackAt: Date | null; approvedAt: Date | null }): BankChangeStage {
  if (row.callbackAt === null) return 'awaiting_callback';
  return row.approvedAt === null ? 'awaiting_approval' : 'cooling_off';
}

/**
 * Changing where a vendor is paid is the largest payables fraud (design doc §17.2), so a bank account is never edited. A change is
 * a new pending account with the bank's letter as evidence; staff phone the vendor on a number from our own records and record
 * the call; a different person approves; and the account is used only after a cool-off, during which payments keep going to the
 * old account. The database also refuses an approval by the person who proposed or called back.
 */
export class VendorBankChangeService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly notify?: VendorNotifier,
    private readonly coolOffDays: number = BANK_COOL_OFF_DAYS,
  ) {}

  private async event(tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0], vendorId: string, event: string, actor: { type: 'user' | 'system' | 'job' | 'integration'; id: string | null }, extra: { reasonText?: string | null; data?: Record<string, unknown>; origin?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(vendorEvents).values({ vendorId, event, reasonText: extra.reasonText ?? null, data: extra.data ?? {}, actorType: actor.type, actorId: actor.id, origin: extra.origin ?? {} });
  }

  /** The vendor asks to add or replace a bank account. Owner and finance only; an approved vendor only. */
  async propose(actor: PortalActor, input: BankInput & { replacesId: string; evidenceDocumentId: string }): Promise<{ id: string }> {
    if (actor.portalRole !== 'owner' && actor.portalRole !== 'finance') throw new ProfileError('NOT_ALLOWED', 'Only the owner or the finance person can ask to change bank details.');
    const problems = checkBanks([input]);
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the form.', problems);
    const number = input.accountNumber.replace(/[\s-]+/g, '').toUpperCase();
    const made = await this.db.transaction(async (tx) => {
      const [v] = await tx.select().from(vendors).where(eq(vendors.id, actor.vendorId)).for('update');
      if (v?.status !== 'active') throw new ProfileError('NOT_EDITABLE', 'Bank details change through the profile until your business is approved. After approval, ask here.');
      const live = await tx.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, v.id), ne(vendorBankAccounts.status, 'retired')));
      if (live.some((b) => b.status === 'pending_change')) throw new ProfileError('PENDING', 'A bank change is already waiting. Withdraw it or wait for the decision before asking again.');
      if (input.replacesId !== '' && !live.some((b) => b.id === input.replacesId && b.status === 'active')) throw new ProfileError('NOT_FOUND', 'Choose one of your current bank accounts to replace.');
      if (input.replacesId === '' && live.length >= MAX_ACCOUNTS) throw new ProfileError('TOO_MANY', 'That is more bank accounts than we can keep (5 at most). Replace one instead.');
      const [evidence] = await tx
        .select({ id: vendorDocuments.id, code: vendorDocumentTypes.code, status: vendorDocuments.status })
        .from(vendorDocuments)
        .innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, vendorDocuments.documentTypeId))
        .where(and(eq(vendorDocuments.id, input.evidenceDocumentId), eq(vendorDocuments.vendorId, v.id)));
      if (evidence?.code !== 'BANK_LETTER' || (evidence.status !== 'submitted' && evidence.status !== 'valid')) {
        throw new ProfileError('EVIDENCE_REQUIRED', 'Upload a bank confirmation letter for the new account first, then choose it here.', { evidenceDocumentId: 'Choose the bank letter for the new account.' });
      }
      const hash = fingerprintSecret(number);
      const sameElsewhere = await tx.select({ id: vendorBankAccounts.id }).from(vendorBankAccounts).innerJoin(vendors, eq(vendors.id, vendorBankAccounts.vendorId)).where(and(eq(vendorBankAccounts.accountHash, hash), ne(vendorBankAccounts.vendorId, v.id), ne(vendorBankAccounts.status, 'retired'), eq(vendors.companyId, v.companyId))).limit(5);
      const [row] = await tx
        .insert(vendorBankAccounts)
        .values({
          vendorId: v.id,
          bankName: input.bankName.trim(),
          branch: input.branch.trim(),
          accountName: input.accountName.trim(),
          accountSealed: encryptCredentials({ number }),
          accountLast4: number.slice(-4),
          accountHash: hash,
          swift: has(input.swift) ? input.swift.trim().toUpperCase() : null,
          status: 'pending_change',
          replacesId: input.replacesId === '' ? null : input.replacesId,
          proposedBy: actor.userId,
          evidenceDocumentId: evidence.id,
          createdBy: actor.userId,
        })
        .returning({ id: vendorBankAccounts.id });
      if (row === undefined) throw new ProfileError('NOT_SAVED', 'The change could not be saved.');
      await this.event(tx, v.id, 'bank_change_proposed', { type: 'user', id: actor.userId }, { data: { bankAccountId: row.id, replaces: input.replacesId === '' ? null : input.replacesId, sameAccountOnOtherVendors: sameElsewhere.length }, origin: { surface: 'vendor/portal', action: 'bank_change_propose' } });
      return { id: row.id, last4: number.slice(-4) };
    });
    await this.notify?.bankChangeProposed(actor.vendorId, input.bankName.trim(), made.last4);
    return { id: made.id };
  }

  /** The vendor takes back a change that nobody has approved yet. */
  async withdraw(actor: PortalActor, id: string): Promise<void> {
    if (actor.portalRole !== 'owner' && actor.portalRole !== 'finance') throw new ProfileError('NOT_ALLOWED', 'Only the owner or the finance person can withdraw a bank change.');
    await this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.id, id), eq(vendorBankAccounts.vendorId, actor.vendorId), eq(vendorBankAccounts.status, 'pending_change'))).for('update');
      if (b === undefined) throw new ProfileError('NOT_FOUND', 'That change is not waiting any more.');
      if (b.approvedAt !== null) throw new ProfileError('ALREADY_APPROVED', 'This change was already approved. Contact the buyer to stop it.');
      await tx.update(vendorBankAccounts).set({ status: 'retired', decisionNote: 'Withdrawn by the vendor' }).where(eq(vendorBankAccounts.id, id));
      await this.event(tx, actor.vendorId, 'bank_change_withdrawn', { type: 'user', id: actor.userId }, { data: { bankAccountId: id }, origin: { surface: 'vendor/portal', action: 'bank_change_withdraw' } });
    });
  }

  private async lockPending(tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0], ctx: FinanceContext, id: string) {
    const [row] = await tx
      .select({ b: vendorBankAccounts, companyId: vendors.companyId })
      .from(vendorBankAccounts)
      .innerJoin(vendors, eq(vendors.id, vendorBankAccounts.vendorId))
      .where(and(eq(vendorBankAccounts.id, id), eq(vendors.companyId, ctx.companyId)))
      .for('update', { of: vendorBankAccounts });
    if (row === undefined) throw new FinanceError('NOT_FOUND', 'That bank change does not exist.');
    if (row.b.status !== 'pending_change') throw new FinanceError('NOT_PENDING', 'That change is no longer waiting for a decision.');
    return row.b;
  }

  /** Staff record that they phoned the vendor on a number from our own records and the vendor confirmed. */
  async recordCallback(ctx: FinanceContext, id: string, note: string): Promise<void> {
    const text = trimToNull(note);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Write who you spoke to, on which number from our records, and what they confirmed.');
    await this.db.transaction(async (tx) => {
      const b = await this.lockPending(tx, ctx, id);
      if (b.callbackAt !== null) throw new FinanceError('ALREADY_DONE', 'The call-back was already recorded.');
      if (b.approvedAt !== null) throw new FinanceError('ALREADY_DONE', 'This change was already approved.');
      await tx.update(vendorBankAccounts).set({ callbackBy: ctx.actor.id, callbackAt: new Date(), callbackNote: text.slice(0, 1000) }).where(eq(vendorBankAccounts.id, id));
      await this.event(tx, b.vendorId, 'bank_change_callback', ctx.actor, { reasonText: text.slice(0, 1000), data: { bankAccountId: id }, origin: { ...ctx.origin } });
    });
  }

  /** A second person approves. The new account starts to be used after the cool-off (at once when the company sets none). */
  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ effectiveFrom: Date }> {
    const done = await this.db.transaction(async (tx) => {
      const b = await this.lockPending(tx, ctx, id);
      if (b.callbackAt === null) throw new FinanceError('CALLBACK_REQUIRED', 'Phone the vendor and record the call before approving.');
      if (b.approvedAt !== null) throw new FinanceError('ALREADY_DONE', 'This change was already approved.');
      if (b.callbackBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'A different person must approve: you recorded the call-back.');
      if (b.proposedBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'You cannot approve a change you asked for.');
      const effectiveFrom = this.coolOffDays === 0 ? now : addBusinessDays(now, this.coolOffDays);
      await tx.update(vendorBankAccounts).set({ approvedBy: ctx.actor.id, approvedAt: now, effectiveFrom }).where(eq(vendorBankAccounts.id, id));
      await this.event(tx, b.vendorId, 'bank_change_approved', ctx.actor, { data: { bankAccountId: id, effectiveFrom: effectiveFrom.toISOString() }, origin: { ...ctx.origin } });
      if (this.coolOffDays === 0) await this.promote(tx, id, 'system');
      return { effectiveFrom, vendorId: b.vendorId };
    });
    await this.notify?.bankChangeDecided(done.vendorId, 'approved', null, done.effectiveFrom);
    return { effectiveFrom: done.effectiveFrom };
  }

  /** Staff refuse the change; the vendor's existing account stays as it is. */
  async reject(ctx: FinanceContext, id: string, note: string): Promise<void> {
    const text = trimToNull(note);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the change is refused.');
    const vendorId = await this.db.transaction(async (tx) => {
      const b = await this.lockPending(tx, ctx, id);
      await tx.update(vendorBankAccounts).set({ status: 'retired', decisionNote: text.slice(0, 500) }).where(eq(vendorBankAccounts.id, id));
      await this.event(tx, b.vendorId, 'bank_change_refused', ctx.actor, { reasonText: text.slice(0, 500), data: { bankAccountId: id }, origin: { ...ctx.origin } });
      return b.vendorId;
    });
    await this.notify?.bankChangeDecided(vendorId, 'refused', text.slice(0, 500), null);
  }

  private async promote(tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0], id: string, by: 'system'): Promise<void> {
    const [b] = await tx.update(vendorBankAccounts).set({ status: 'active' }).where(and(eq(vendorBankAccounts.id, id), eq(vendorBankAccounts.status, 'pending_change'))).returning();
    if (b === undefined) return;
    if (b.replacesId !== null) await tx.update(vendorBankAccounts).set({ status: 'retired', decisionNote: 'Replaced by an approved change' }).where(and(eq(vendorBankAccounts.id, b.replacesId), eq(vendorBankAccounts.status, 'active')));
    await this.event(tx, b.vendorId, 'bank_change_effective', { type: by, id: null }, { data: { bankAccountId: id, replaced: b.replacesId } });
  }

  /** Puts approved accounts into use once their cool-off has passed. Safe to run any time and from several places. */
  async promoteDue(now: Date = new Date()): Promise<number> {
    let promoted = 0;
    for (;;) {
      const done = await this.db.transaction(async (tx) => {
        const due = await tx
          .select({ id: vendorBankAccounts.id })
          .from(vendorBankAccounts)
          .where(and(eq(vendorBankAccounts.status, 'pending_change'), isNotNull(vendorBankAccounts.approvedAt), lte(vendorBankAccounts.effectiveFrom, now)))
          .orderBy(vendorBankAccounts.effectiveFrom)
          .limit(50)
          .for('update', { skipLocked: true });
        for (const row of due) await this.promote(tx, row.id, 'system');
        return due.length;
      });
      promoted += done;
      if (done < 50) return promoted;
    }
  }

  /** The accounts a payment may use right now: active ones only. A pending change never receives money. */
  async payableAccounts(vendorId: string, now: Date = new Date()) {
    await this.promoteDue(now);
    return await this.db.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, vendorId), eq(vendorBankAccounts.status, 'active')));
  }

  /** Changes waiting for staff, oldest first. */
  async worklist(companyId: string, limit = 100) {
    const rows = await this.db
      .select({ b: vendorBankAccounts, legalName: vendors.legalName, number: vendors.number })
      .from(vendorBankAccounts)
      .innerJoin(vendors, eq(vendors.id, vendorBankAccounts.vendorId))
      .where(and(eq(vendors.companyId, companyId), eq(vendorBankAccounts.status, 'pending_change')))
      .orderBy(vendorBankAccounts.createdAt)
      .limit(Math.min(limit, 200));
    const replacedIds = rows.map((r) => r.b.replacesId).filter((x): x is string => x !== null);
    const old = replacedIds.length === 0 ? [] : await this.db.select({ id: vendorBankAccounts.id, bankName: vendorBankAccounts.bankName, last4: vendorBankAccounts.accountLast4 }).from(vendorBankAccounts).where(inArray(vendorBankAccounts.id, replacedIds));
    const evidenceIds = rows.map((r) => r.b.evidenceDocumentId).filter((x): x is string => x !== null);
    const evidence = evidenceIds.length === 0 ? [] : await this.db.select({ id: vendorDocuments.id, fileId: vendorDocuments.fileId }).from(vendorDocuments).where(inArray(vendorDocuments.id, evidenceIds));
    const hashes = rows.map((r) => r.b.accountHash);
    const dupes = hashes.length === 0 ? [] : await this.db.select({ hash: vendorBankAccounts.accountHash, vendorId: vendorBankAccounts.vendorId }).from(vendorBankAccounts).where(and(inArray(vendorBankAccounts.accountHash, hashes), ne(vendorBankAccounts.status, 'retired')));
    return rows.map((r) => ({
      id: r.b.id,
      vendorId: r.b.vendorId,
      vendorName: r.legalName,
      vendorNumber: r.number,
      bankName: r.b.bankName,
      branch: r.b.branch,
      accountName: r.b.accountName,
      last4: r.b.accountLast4,
      stage: bankChangeStage(r.b),
      proposedAt: r.b.createdAt.toISOString(),
      callbackBy: r.b.callbackBy,
      callbackNote: r.b.callbackNote,
      approvedAt: r.b.approvedAt?.toISOString() ?? null,
      effectiveFrom: r.b.effectiveFrom?.toISOString() ?? null,
      replaces: old.find((o) => o.id === r.b.replacesId) ?? null,
      evidenceFileId: evidence.find((e) => e.id === r.b.evidenceDocumentId)?.fileId ?? null,
      sameAccountOnOtherVendors: dupes.filter((d) => d.hash === r.b.accountHash && d.vendorId !== r.b.vendorId).length,
    }));
  }

  /** What the vendor sees of its own pending change: no one else's, and never the number. */
  async forVendor(vendorId: string) {
    const rows = await this.db.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, vendorId), eq(vendorBankAccounts.status, 'pending_change'))).orderBy(desc(vendorBankAccounts.createdAt));
    return rows.map((b) => ({ id: b.id, bankName: b.bankName, branch: b.branch, accountName: b.accountName, last4: b.accountLast4, stage: bankChangeStage(b), effectiveFrom: b.effectiveFrom?.toISOString() ?? null, replacesId: b.replacesId }));
  }
}
