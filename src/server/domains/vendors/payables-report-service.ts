import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { glAccounts, glAccountBalances, payablesChecks, vendorLedgerEntries, vendorPostingGroups, vendors } from '@/server/db/drizzle/schema';
import type { VendorLedgerService } from '@/server/domains/finance/payables/vendor-ledger-service';
import { has } from '@/lib/values';
import type { PayablesFxService } from './payables-fx-service';
import { AGE_BUCKETS, toCents, type AgeBucket } from '@/lib/vendor-payment';

/**
 * What we owe, from the vendor ledger (design doc §12.8): payables ageing by due date, and a vendor's statement. The ledger is the
 * only source, so these figures agree with what was booked and paid. Amounts are cents in the base currency; other currencies
 * are not booked yet.
 */
export class PayablesReportService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ledger: VendorLedgerService,
    private readonly fx: PayablesFxService,
  ) {}

  async ageing(companyId: string, asOf: string) {
    const days = sql`(${asOf}::date - COALESCE(${vendorLedgerEntries.dueDate}, ${vendorLedgerEntries.postingDate}))`;
    const amount = (cond: ReturnType<typeof sql>) => sql<string>`COALESCE(SUM(CASE WHEN ${vendorLedgerEntries.documentType} = 'invoice' AND ${vendorLedgerEntries.remainingAmount} > 0 AND ${cond} THEN ${vendorLedgerEntries.remainingAmount} ELSE 0 END), 0)::text`;
    const rows = await this.db
      .select({
        vendorId: vendors.id,
        name: vendors.legalName,
        number: vendors.number,
        currency: vendorLedgerEntries.currency,
        not_due: amount(sql`${days} <= 0`),
        d1_30: amount(sql`${days} BETWEEN 1 AND 30`),
        d31_60: amount(sql`${days} BETWEEN 31 AND 60`),
        d61_90: amount(sql`${days} BETWEEN 61 AND 90`),
        d90_plus: amount(sql`${days} > 90`),
        unapplied: sql<string>`COALESCE(SUM(CASE WHEN ${vendorLedgerEntries.remainingAmount} < 0 THEN ${vendorLedgerEntries.remainingAmount} ELSE 0 END), 0)::text`,
      })
      .from(vendorLedgerEntries)
      .innerJoin(vendors, eq(vendors.id, vendorLedgerEntries.vendorId))
      .where(and(eq(vendorLedgerEntries.companyId, companyId), sql`${vendorLedgerEntries.remainingAmount} <> 0`))
      .groupBy(vendors.id, vendors.legalName, vendors.number, vendorLedgerEntries.currency)
      .orderBy(asc(vendors.legalName));
    const lines = rows.map((r) => {
      const buckets = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, toCents(r[b.key])])) as Record<AgeBucket, number>;
      const owed = Object.values(buckets).reduce((s, c) => s + c, 0);
      const unapplied = toCents(r.unapplied);
      return { vendorId: r.vendorId, name: r.name, number: r.number, currency: r.currency, buckets, owedCents: owed, unappliedCents: unapplied, netCents: owed + unapplied };
    });
    const totals = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, lines.reduce((s, l) => s + l.buckets[b.key], 0)])) as Record<AgeBucket, number>;
    return { asOf, lines, totals, owedCents: lines.reduce((s, l) => s + l.owedCents, 0), unappliedCents: lines.reduce((s, l) => s + l.unappliedCents, 0) };
  }

  /** A vendor's entries, newest first, with what is still open on each. */
  async statement(companyId: string, vendorId: string, range: { from?: string; to?: string } = {}, limit = 200) {
    const [v] = await this.db.select({ id: vendors.id, name: vendors.legalName, number: vendors.number }).from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, vendorId)));
    if (v === undefined) return null;
    const conds = [eq(vendorLedgerEntries.companyId, companyId), eq(vendorLedgerEntries.vendorId, vendorId)];
    if (has(range.from)) conds.push(gte(vendorLedgerEntries.postingDate, range.from));
    if (has(range.to)) conds.push(lte(vendorLedgerEntries.postingDate, range.to));
    const entries = await this.db
      .select()
      .from(vendorLedgerEntries)
      .where(and(...conds))
      .orderBy(desc(vendorLedgerEntries.postingDate), desc(vendorLedgerEntries.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    const [open] = await this.db
      .select({ owed: sql<string>`COALESCE(SUM(${vendorLedgerEntries.remainingAmount}), 0)::text` })
      .from(vendorLedgerEntries)
      .where(and(eq(vendorLedgerEntries.companyId, companyId), eq(vendorLedgerEntries.vendorId, vendorId)));
    return {
      vendor: v,
      balance: open?.owed ?? '0',
      entries: entries.map((e) => ({ id: e.id, documentType: e.documentType, documentNo: e.documentNo, externalNo: e.externalDocumentNo, postingDate: e.postingDate, dueDate: e.dueDate, amount: e.amount, remaining: e.remainingAmount, currency: e.currency })),
    };
  }

  /**
   * The vendor ledger against the books (design doc §12.7): what the ledger says we owe against the general ledger's payables account,
   * and the advances paid against the prepayments account, per account the vendor groups post to. A difference is a defect and is
   * shown with the ledger entries whose open amount does not match their detailed entries.
   */
  async reconcile(companyId: string) {
    const owed = await this.db
      .select({
        accountId: vendorPostingGroups.payablesAccountId,
        total: sql<string>`COALESCE(SUM(CASE WHEN ${vendorLedgerEntries.documentType} <> 'advance' THEN ROUND(${vendorLedgerEntries.remainingAmount} * ${vendorLedgerEntries.rate}, 2) ELSE 0 END), 0)::text`,
      })
      .from(vendorLedgerEntries)
      .innerJoin(vendors, eq(vendors.id, vendorLedgerEntries.vendorId))
      .innerJoin(vendorPostingGroups, eq(vendorPostingGroups.id, vendors.postingGroupId))
      .where(eq(vendorLedgerEntries.companyId, companyId))
      .groupBy(vendorPostingGroups.payablesAccountId);
    const advances = await this.db
      .select({
        accountId: vendorPostingGroups.prepaymentsAccountId,
        total: sql<string>`COALESCE(SUM(CASE WHEN ${vendorLedgerEntries.documentType} = 'advance' THEN ROUND(${vendorLedgerEntries.remainingAmount} * ${vendorLedgerEntries.rate}, 2) ELSE 0 END), 0)::text`,
      })
      .from(vendorLedgerEntries)
      .innerJoin(vendors, eq(vendors.id, vendorLedgerEntries.vendorId))
      .innerJoin(vendorPostingGroups, eq(vendorPostingGroups.id, vendors.postingGroupId))
      .where(eq(vendorLedgerEntries.companyId, companyId))
      .groupBy(vendorPostingGroups.prepaymentsAccountId);
    const wanted = [...owed.map((o) => o.accountId), ...advances.map((a) => a.accountId)].filter((x): x is string => x !== null);
    const accounts = wanted.length === 0 ? [] : await this.db.select({ id: glAccounts.id, no: glAccounts.no, name: glAccounts.name }).from(glAccounts).where(inArray(glAccounts.id, wanted));
    const balances = wanted.length === 0 ? [] : await this.db
      .select({ accountId: glAccountBalances.accountId, debit: sql<string>`COALESCE(SUM(${glAccountBalances.baseDebit}), 0)::text`, credit: sql<string>`COALESCE(SUM(${glAccountBalances.baseCredit}), 0)::text` })
      .from(glAccountBalances)
      .where(and(eq(glAccountBalances.companyId, companyId), inArray(glAccountBalances.accountId, wanted)))
      .groupBy(glAccountBalances.accountId);
    const bal = new Map(balances.map((b) => [b.accountId, b]));
    const rows: { accountId: string; accountNo: string; accountName: string; purpose: 'payables' | 'prepayments'; ledgerCents: number; glCents: number; diffCents: number }[] = [];
    const add = (accountId: string | null, purpose: 'payables' | 'prepayments', ledgerCents: number): void => {
      if (accountId === null) return;
      const a = accounts.find((x) => x.id === accountId);
      const b = bal.get(accountId);
      // Payables are a credit balance (we owe); prepayments are a debit balance (we paid ahead).
      const glCents = b === undefined ? 0 : toCents(purpose === 'payables' ? (Number(b.credit) - Number(b.debit)).toFixed(2) : (Number(b.debit) - Number(b.credit)).toFixed(2));
      const existing = rows.find((r) => r.accountId === accountId && r.purpose === purpose);
      if (existing !== undefined) {
        existing.ledgerCents += ledgerCents;
        existing.diffCents = existing.glCents - existing.ledgerCents;
        return;
      }
      rows.push({ accountId, accountNo: a?.no ?? '', accountName: a?.name ?? '', purpose, ledgerCents, glCents, diffCents: glCents - ledgerCents });
    };
    for (const o of owed) add(o.accountId, 'payables', toCents(Number(o.total).toFixed(2)));
    // A revaluation that is still standing has moved the books' payables off the rates the ledger carries; it is part of what the books say.
    const standing = await this.fx.standingByGroup(companyId);
    if (standing.size > 0) {
      const groups = await this.db.select({ id: vendorPostingGroups.id, accountId: vendorPostingGroups.payablesAccountId }).from(vendorPostingGroups).where(inArray(vendorPostingGroups.id, [...standing.keys()].filter((k) => k !== '')));
      for (const g of groups) add(g.accountId, 'payables', standing.get(g.id) ?? 0);
    }
    for (const a of advances) add(a.accountId, 'prepayments', -toCents(Number(a.total).toFixed(2)));
    const drift = await this.ledger.drift(companyId);
    const differences = rows.filter((r) => r.diffCents !== 0).length + drift.length;
    return { rows, drift, differences, ok: differences === 0 };
  }

  /** Runs the comparison and keeps the result: the nightly job and the "check now" button both come here. */
  async runCheck(companyId: string, ranBy: string) {
    const r = await this.reconcile(companyId);
    const [row] = await this.db.insert(payablesChecks).values({ companyId, ranBy, ok: r.ok, differences: r.differences, rows: r.rows, drift: r.drift }).returning();
    return { id: row?.id ?? '', ranAt: row?.ranAt.toISOString() ?? '', ranBy, ...r };
  }

  async lastCheck(companyId: string) {
    const [row] = await this.db.select().from(payablesChecks).where(eq(payablesChecks.companyId, companyId)).orderBy(desc(payablesChecks.ranAt)).limit(1);
    return row === undefined ? null : { id: row.id, ranAt: row.ranAt.toISOString(), ranBy: row.ranBy, ok: row.ok, differences: row.differences, rows: row.rows, drift: row.drift };
  }
}
