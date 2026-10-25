import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  glAccounts,
  vendorEvents,
  vendorPostingGroups,
  vendorUsers,
  vendors,
  type VendorRow,
  type VendorStatus,
} from '@/server/db/drizzle/schema';
import { has } from '@/lib/values';
import { normaliseTaxId, type VendorCreation } from '@/lib/vendor-forms';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import { isUniqueViolation } from '@/server/domains/settings/errors';

export type VendorTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type Tx = VendorTx;

export interface VendorListFilter {
  q?: string;
  status?: string;
  /** Keyset cursor: the created_at (with microseconds) and id of the last row of the previous page. */
  before?: { createdAt: string; id: string } | null;
  limit?: number;
}

const PAGE = 25;
const origin = (ctx: FinanceContext) => ({ ...ctx.origin });

/**
 * The vendor master (docs/architecture/vendor-management-module.md §5-6). Staff create and read vendors here; the vendor's
 * own sign-up and profile are in the portal slices. Every change writes an event with who, what and from where.
 */
export class VendorService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
  ) {}

  private async event(
    tx: Tx | DrizzleDb,
    vendorId: string,
    event: string,
    from: string | null,
    to: string | null,
    actor: { type: 'user' | 'system' | 'job' | 'integration'; id: string | null },
    originInfo: Record<string, unknown>,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(vendorEvents).values({ vendorId, event, fromStatus: from, toStatus: to, data, actorType: actor.type, actorId: actor.id, origin: originInfo });
  }

  /**
   * The posting group a new vendor starts in: the company's `TRADE` group, made on first use from the chart's standard
   * accounts (trade creditors, prepayments) when they exist. Accounts the chart does not have are left empty and
   * posting refuses with a clear message later, never guesses.
   */
  async defaultPostingGroupId(companyId: string): Promise<string> {
    const [found] = await this.db
      .select({ id: vendorPostingGroups.id })
      .from(vendorPostingGroups)
      .where(and(eq(vendorPostingGroups.companyId, companyId), eq(vendorPostingGroups.code, 'TRADE')));
    if (found !== undefined) return found.id;
    const accounts = await this.db.select({ id: glAccounts.id, no: glAccounts.no }).from(glAccounts).where(eq(glAccounts.companyId, companyId));
    const byNo = new Map(accounts.map((a) => [a.no, a.id]));
    const [made] = await this.db
      .insert(vendorPostingGroups)
      .values({
        companyId,
        code: 'TRADE',
        name: 'Trade vendors',
        payablesAccountId: byNo.get('2110') ?? null,
        prepaymentsAccountId: byNo.get('1430') ?? null,
        paymentDiscountAccountId: byNo.get('4420') ?? null,
        paymentToleranceAccountId: byNo.get('4420') ?? null,
        withholdingPayableAccountId: byNo.get('2350') ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: vendorPostingGroups.id });
    if (made !== undefined) return made.id;
    const [again] = await this.db
      .select({ id: vendorPostingGroups.id })
      .from(vendorPostingGroups)
      .where(and(eq(vendorPostingGroups.companyId, companyId), eq(vendorPostingGroups.code, 'TRADE')));
    if (again === undefined) throw new FinanceError('POSTING_GROUP_MISSING', 'The default vendor posting group could not be created.');
    return again.id;
  }

  /** Adds a vendor on the company's behalf. `activate` needs the extra permission and gives it a number at once. */
  async createByStaff(ctx: FinanceContext, input: VendorCreation, activate: boolean): Promise<{ id: string; number: string | null }> {
    const taxId = normaliseTaxId(input.taxId);
    const postingGroupId = await this.defaultPostingGroupId(ctx.companyId);
    try {
      return await this.db.transaction(async (tx) => {
        const [made] = await tx
          .insert(vendors)
          .values({
            companyId: ctx.companyId,
            status: 'registered',
            vendorType: input.vendorType,
            legalName: input.legalName.trim(),
            tradingName: has(input.tradingName) ? input.tradingName.trim() : null,
            taxId,
            country: has(input.country) ? input.country.trim() : null,
            email: input.email.trim().toLowerCase(),
            phone: has(input.phone) ? input.phone.trim() : null,
            postingGroupId,
            paymentTermDays: Number(input.paymentTermDays),
            currency: has(input.currency) ? input.currency.trim().toUpperCase() : null,
            approvedExpenseVendor: input.approvedExpenseVendor,
            createdByStaff: true,
            notes: has(input.notes) ? input.notes.trim() : null,
          })
          .returning({ id: vendors.id });
        if (made === undefined) throw new FinanceError('VENDOR_NOT_CREATED', 'The vendor could not be saved.');
        await this.event(tx, made.id, 'created_by_staff', null, 'registered', ctx.actor, origin(ctx), { activated: activate });
        let number: string | null = null;
        if (activate) number = await this.activateIn(tx, ctx, made.id, 'registered');
        return { id: made.id, number };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new FinanceError('VENDOR_DUPLICATE', 'A vendor with this tax ID already exists.');
      throw error;
    }
  }

  /** Gives the vendor its number and makes it active. Runs inside the caller's transaction. */
  async activateIn(tx: Tx, ctx: FinanceContext, vendorId: string, from: VendorStatus): Promise<string> {
    const { number } = await this.numbering.assign(
      'vendor',
      { companyId: ctx.companyId, branchId: null, date: businessDate(), document: { kind: 'vendor', id: vendorId } },
      tx,
    );
    await tx.update(vendors).set({ number, status: 'active', updatedAt: new Date() }).where(eq(vendors.id, vendorId));
    await this.event(tx, vendorId, 'activated', from, 'active', ctx.actor, origin(ctx), { number });
    return number;
  }

  /** A page of vendors, newest first. Searches name, number, email and tax id on the server. */
  async list(companyId: string, f: VendorListFilter = {}): Promise<{ rows: VendorRow[]; next: { createdAt: string; id: string } | null }> {
    const limit = Math.min(Math.max(f.limit ?? PAGE, 1), 100);
    const conds: SQL[] = [eq(vendors.companyId, companyId)];
    if (has(f.status)) conds.push(eq(vendors.status, f.status as VendorStatus));
    if (has(f.q)) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const search = or(ilike(vendors.legalName, like), ilike(vendors.tradingName, like), ilike(vendors.number, like), ilike(vendors.email, like), ilike(vendors.taxId, like));
      if (search !== undefined) conds.push(search);
    }
    if (f.before) {
      // Timestamp cursors keep microseconds: compare the stored text, not a rounded Date.
      conds.push(sql`(${vendors.createdAt}::text, ${vendors.id}::text) < (${f.before.createdAt}, ${f.before.id})`);
    }
    const found = await this.db
      .select({ vendor: vendors, stamp: sql<string>`${vendors.createdAt}::text` })
      .from(vendors)
      .where(and(...conds))
      .orderBy(desc(vendors.createdAt), desc(vendors.id))
      .limit(limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    const next = found.length > limit && last !== undefined ? { createdAt: last.stamp, id: last.vendor.id } : null;
    return { rows: page.map((r) => r.vendor), next };
  }

  async get(companyId: string, id: string) {
    const [row] = await this.db
      .select({ vendor: vendors, postingGroup: vendorPostingGroups.name })
      .from(vendors)
      .leftJoin(vendorPostingGroups, eq(vendorPostingGroups.id, vendors.postingGroupId))
      .where(and(eq(vendors.companyId, companyId), eq(vendors.id, id)));
    if (row === undefined) return null;
    const [portalUsers, events] = await Promise.all([
      this.db.execute<{ id: string; name: string; email: string; portal_role: string; status: string; last_login_at: string | null; joined: boolean }>(sql`
        SELECT vu.id, u.name, u.email, vu.portal_role, vu.status, u.last_login_at::text AS last_login_at, (u.email_verified_at IS NOT NULL) AS joined
        FROM vendor_users vu JOIN users u ON u.id = vu.user_id WHERE vu.vendor_id = ${id}::uuid ORDER BY vu.created_at`),
      this.db.select().from(vendorEvents).where(eq(vendorEvents.vendorId, id)).orderBy(desc(vendorEvents.id)).limit(100),
    ]);
    return { ...row, portalUsers: [...portalUsers], events };
  }

  /** The vendor a signed-in portal user belongs to, with their portal role; null when they have none or it was removed. */
  async forPortalUser(userId: string): Promise<{ vendorId: string; portalRole: string; status: VendorStatus; block: string; legalName: string } | null> {
    const [row] = await this.db
      .select({ vendorId: vendors.id, portalRole: vendorUsers.portalRole, status: vendors.status, block: vendors.block, legalName: vendors.legalName })
      .from(vendorUsers)
      .innerJoin(vendors, eq(vendors.id, vendorUsers.vendorId))
      .where(and(eq(vendorUsers.userId, userId), eq(vendorUsers.status, 'active')));
    return row ?? null;
  }

  /** What a vendor may see about its own record: never staff notes, posting groups or events. */
  async portalView(vendorId: string): Promise<{ legalName: string; status: VendorStatus; block: string; number: string | null } | null> {
    const [row] = await this.db
      .select({ legalName: vendors.legalName, status: vendors.status, block: vendors.block, number: vendors.number })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    return row ?? null;
  }

  /**
   * A vendor business signs up: the login (role `vendor`, email not yet verified), the business and its owner link are
   * created together, so there is never a login without a business. The caller creates the user first and passes its id.
   */
  async registerBusiness(input: { companyId: string; userId: string; legalName: string; email: string; phone: string | null }): Promise<string> {
    const postingGroupId = await this.defaultPostingGroupId(input.companyId);
    return await this.db.transaction(async (tx) => {
      const [made] = await tx
        .insert(vendors)
        .values({
          companyId: input.companyId,
          status: 'registered',
          legalName: input.legalName.trim(),
          email: input.email.trim().toLowerCase(),
          phone: input.phone,
          postingGroupId,
        })
        .returning({ id: vendors.id });
      if (made === undefined) throw new FinanceError('VENDOR_NOT_CREATED', 'The business could not be registered.');
      await tx.insert(vendorUsers).values({ vendorId: made.id, userId: input.userId, portalRole: 'owner' });
      await this.event(tx, made.id, 'registered', null, 'registered', { type: 'user', id: input.userId }, { surface: 'vendor/register', action: 'register' });
      return made.id;
    });
  }
}
