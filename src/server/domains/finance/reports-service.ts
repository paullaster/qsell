import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  fiscalYears,
  glAccounts,
  glEntries,
  ledgerRegisters,
} from '@/server/db/drizzle/schema';
import { formatAmount, parseAmount } from './domain/amount';
import { compareAccountNo, totalBalance } from './domain/chart';
import { GENESIS_HASH, registerHash } from './domain/hash';

import { has } from '@/lib/values';

export interface TrialBalanceRow {
  accountId: string;
  no: string;
  name: string;
  type: string;
  indent: number;
  category: string | null;
  openingDebit: string;
  openingCredit: string;
  debit: string;
  credit: string;
  closingDebit: string;
  closingCredit: string;
}

const PROFIT_AND_LOSS = new Set(['income', 'cost_of_sales', 'expense']);

/** Splits a net balance (debit positive) into a debit column and a credit column. */
function sides(net: bigint): [string, string] {
  return net >= 0n ? [formatAmount(net), formatAmount(0n)] : [formatAmount(0n), formatAmount(-net)];
}

export class FinanceReportsService {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Trial balance for a date range, from the running balances (never a scan of the ledger).
   * Balance-sheet accounts open with everything before the range; profit-and-loss accounts open
   * with what was earned earlier in the same fiscal year, since year-end closing is a later step.
   */
  async trialBalance(companyId: string, from: string, to: string): Promise<{ rows: TrialBalanceRow[]; totalDebit: string; totalCredit: string }> {
    const [fy] = await this.db
      .select({ startsOn: fiscalYears.startsOn })
      .from(fiscalYears)
      .where(and(eq(fiscalYears.companyId, companyId), lte(fiscalYears.startsOn, from), gte(fiscalYears.endsOn, from)))
      .limit(1);
    const yearStart = fy?.startsOn ?? from;

    const accounts = await this.db.select().from(glAccounts).where(eq(glAccounts.companyId, companyId));
    const rows = await this.db.execute<{
      account_id: string;
      opening_all: string;
      opening_year: string;
      debit: string;
      credit: string;
    }>(sql`
      SELECT b.account_id,
        COALESCE(SUM(b.base_debit - b.base_credit) FILTER (WHERE p.ends_on < ${from}::date), 0) AS opening_all,
        COALESCE(SUM(b.base_debit - b.base_credit) FILTER (WHERE p.ends_on < ${from}::date AND p.starts_on >= ${yearStart}::date), 0) AS opening_year,
        COALESCE(SUM(b.base_debit) FILTER (WHERE p.starts_on >= ${from}::date AND p.ends_on <= ${to}::date), 0) AS debit,
        COALESCE(SUM(b.base_credit) FILTER (WHERE p.starts_on >= ${from}::date AND p.ends_on <= ${to}::date), 0) AS credit
      FROM gl_account_balances b
      JOIN accounting_periods p ON p.id = b.period_id
      WHERE b.company_id = ${companyId}::uuid
      GROUP BY b.account_id`);
    const byAccount = new Map(rows.map((r) => [r.account_id, r]));

    const computed = accounts
      .map((a) => {
        const r = byAccount.get(a.id);
        const opening = parseAmount(PROFIT_AND_LOSS.has(a.category ?? '') ? (r?.opening_year ?? '0') : (r?.opening_all ?? '0'));
        const debit = parseAmount(r?.debit ?? '0');
        const credit = parseAmount(r?.credit ?? '0');
        return { a, opening, debit, credit, closing: opening + debit - credit };
      })
      .sort((x, y) => compareAccountNo(x.a.no, y.a.no));

    const balances = computed.map((c) => ({ no: c.a.no, type: c.a.type as 'posting', net: c.closing }));
    let totalDebit = 0n;
    let totalCredit = 0n;
    const out: TrialBalanceRow[] = [];
    for (const c of computed) {
      const isTotal = c.a.type === 'total' || c.a.type === 'end_total';
      const isPosting = c.a.type === 'posting';
      if (isPosting && c.opening === 0n && c.debit === 0n && c.credit === 0n) continue;
      if (isTotal && has(c.a.totaling)) {
        const net = totalBalance(c.a.totaling, balances);
        const [cd, cc] = sides(net);
        out.push({
          accountId: c.a.id, no: c.a.no, name: c.a.name, type: c.a.type, indent: c.a.indent, category: c.a.category,
          openingDebit: '', openingCredit: '', debit: '', credit: '', closingDebit: cd, closingCredit: cc,
        });
        continue;
      }
      if (!isPosting) continue; // headings carry no figures
      const [od, oc] = sides(c.opening);
      const [cd, cc] = sides(c.closing);
      totalDebit += c.debit;
      totalCredit += c.credit;
      out.push({
        accountId: c.a.id, no: c.a.no, name: c.a.name, type: c.a.type, indent: c.a.indent, category: c.a.category,
        openingDebit: od, openingCredit: oc, debit: formatAmount(c.debit), credit: formatAmount(c.credit),
        closingDebit: cd, closingCredit: cc,
      });
    }
    return { rows: out, totalDebit: formatAmount(totalDebit), totalCredit: formatAmount(totalCredit) };
  }

  /** Ledger entries, newest first, with keyset paging on (date, id). */
  async entries(
    companyId: string,
    f: { accountId?: string; from?: string; to?: string; documentNo?: string; registerId?: string; cursor?: { date: string; id: number }; limit?: number },
  ) {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const where: SQL[] = [eq(glEntries.companyId, companyId)];
    if (has(f.accountId)) where.push(eq(glEntries.accountId, f.accountId));
    if (has(f.from)) where.push(gte(glEntries.postingDate, f.from));
    if (has(f.to)) where.push(lte(glEntries.postingDate, f.to));
    if (has(f.documentNo)) where.push(eq(glEntries.documentNo, f.documentNo));
    if (has(f.registerId)) where.push(eq(glEntries.registerId, f.registerId));
    if (f.cursor) {
      where.push(sql`(${glEntries.postingDate}, ${glEntries.id}) < (${f.cursor.date}::date, ${f.cursor.id}::bigint)`);
    }
    const rows = await this.db
      .select({
        id: glEntries.id,
        postingDate: glEntries.postingDate,
        registerId: glEntries.registerId,
        accountId: glEntries.accountId,
        accountNo: glAccounts.no,
        accountName: glAccounts.name,
        documentType: glEntries.documentType,
        documentNo: glEntries.documentNo,
        description: glEntries.description,
        debit: glEntries.debit,
        credit: glEntries.credit,
        baseDebit: glEntries.baseDebit,
        baseCredit: glEntries.baseCredit,
        currency: glEntries.currency,
      })
      .from(glEntries)
      .innerJoin(glAccounts, eq(glAccounts.id, glEntries.accountId))
      .where(and(...where))
      .orderBy(desc(glEntries.postingDate), desc(glEntries.id))
      .limit(limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { rows: page, next: more && last ? { date: last.postingDate, id: last.id } : null };
  }

  async register(companyId: string, registerId: string) {
    const [r] = await this.db
      .select()
      .from(ledgerRegisters)
      .where(and(eq(ledgerRegisters.companyId, companyId), eq(ledgerRegisters.id, registerId)));
    if (!r) return null;
    const lines = await this.db
      .select({
        lineNo: glEntries.lineNo,
        accountNo: glAccounts.no,
        accountName: glAccounts.name,
        debit: glEntries.debit,
        credit: glEntries.credit,
        description: glEntries.description,
      })
      .from(glEntries)
      .innerJoin(glAccounts, eq(glAccounts.id, glEntries.accountId))
      .where(and(eq(glEntries.registerId, registerId), eq(glEntries.postingDate, r.postingDate)))
      .orderBy(asc(glEntries.lineNo));
    return { register: r, lines };
  }

  async registers(companyId: string, limit = 50) {
    return await this.db
      .select()
      .from(ledgerRegisters)
      .where(eq(ledgerRegisters.companyId, companyId))
      .orderBy(desc(ledgerRegisters.postedAt))
      .limit(Math.min(limit, 200));
  }

  /**
   * Recomputes every register's hash from what is stored and checks the chain links and the
   * numbering. Reports the first problem found per chain. Bounded by `perChainLimit` registers.
   */
  async verifyChain(companyId: string, perChainLimit = 5000) {
    const chains = await this.db
      .selectDistinct({ chainKey: ledgerRegisters.chainKey })
      .from(ledgerRegisters)
      .where(eq(ledgerRegisters.companyId, companyId));
    const results: { chainKey: string; checked: number; ok: boolean; problem: string | null }[] = [];
    for (const { chainKey } of chains) {
      const regs = await this.db
        .select()
        .from(ledgerRegisters)
        .where(and(eq(ledgerRegisters.companyId, companyId), eq(ledgerRegisters.chainKey, chainKey)))
        .orderBy(asc(ledgerRegisters.seq))
        .limit(perChainLimit);
      let previous = GENESIS_HASH;
      let expectedSeq = 1;
      let problem: string | null = null;
      for (const r of regs) {
        if (r.seq !== expectedSeq) {
          problem = `Register ${expectedSeq} is missing from chain ${chainKey} (found ${r.seq}).`;
          break;
        }
        if (r.previousHash !== previous) {
          problem = `Register ${r.seq} of chain ${chainKey} does not follow the one before it.`;
          break;
        }
        const entries = await this.db
          .select()
          .from(glEntries)
          .where(and(eq(glEntries.registerId, r.id), eq(glEntries.postingDate, r.postingDate)))
          .orderBy(asc(glEntries.lineNo));
        const expected = registerHash(r.previousHash, {
          companyId,
          chainKey,
          seq: r.seq,
          idempotencyKey: r.idempotencyKey,
          postingDate: r.postingDate,
          currency: r.currency,
          totalDebit: formatAmount(parseAmount(r.totalDebit)),
          totalCredit: formatAmount(parseAmount(r.totalCredit)),
          lineCount: r.lineCount,
          lines: entries.map((e) => ({
            accountId: e.accountId,
            debit: formatAmount(parseAmount(e.debit)),
            credit: formatAmount(parseAmount(e.credit)),
            dimensionSetId: e.dimensionSetId,
          })),
          reversalOf: r.reversalOfId,
        });
        if (expected !== r.hash || entries.length !== r.lineCount) {
          problem = `Register ${r.seq} of chain ${chainKey} has been altered.`;
          break;
        }
        previous = r.hash;
        expectedSeq += 1;
      }
      results.push({ chainKey, checked: regs.length, ok: problem === null, problem });
    }
    return results;
  }

  /** Per-account difference between the running balances and the ledger itself (empty = agree). */
  async balanceDrift(companyId: string, from: string, to: string) {
    return await this.db.execute<{ account_id: string; ledger: string; running: string }>(sql`
      WITH ledger AS (
        SELECT account_id, SUM(base_debit - base_credit) AS net
        FROM gl_entries
        WHERE company_id = ${companyId}::uuid AND posting_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY account_id),
      running AS (
        SELECT b.account_id, SUM(b.base_debit - b.base_credit) AS net
        FROM gl_account_balances b JOIN accounting_periods p ON p.id = b.period_id
        WHERE b.company_id = ${companyId}::uuid AND p.starts_on >= ${from}::date AND p.ends_on <= ${to}::date
        GROUP BY b.account_id)
      SELECT COALESCE(l.account_id, r.account_id) AS account_id,
             COALESCE(l.net, 0)::text AS ledger, COALESCE(r.net, 0)::text AS running
      FROM ledger l FULL JOIN running r ON r.account_id = l.account_id
      WHERE COALESCE(l.net, 0) <> COALESCE(r.net, 0)`);
  }
}
