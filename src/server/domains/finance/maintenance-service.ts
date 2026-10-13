import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { accountingPeriods, ledgerRegisters, glEntries } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { formatAmount, parseAmount } from './domain/amount';
import { registerHash } from './domain/hash';
import type { CustomerLedgerService } from './receivables/customer-ledger-service';
import type { FinanceReportsService } from './reports-service';
import type { SalesPostingService } from './sales-posting-service';

export interface IntegrityReport {
  ranAt: string;
  /** Accounts whose running balances differ from their ledger lines (should be 0). */
  balanceDrift: number;
  /** Customer ledger entries whose open amount differs from their history (should be 0). */
  customerDrift: number;
  /** Hash chains whose most recent registers do not verify (should be 0). */
  chainProblems: { chainKey: string; problem: string }[];
  /** Sales events that could not be posted and have been waiting over an hour (should be 0). */
  stuckSalesPostings: number;
  ok: boolean;
}

/**
 * The jobs that keep the books honest over time: new ledger partitions before they are needed,
 * and a nightly check that every figure we store for speed still agrees with the record it
 * summarises. A disagreement is written to the audit trail and logged as an error, loudly.
 */
export class FinanceMaintenanceService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reports: FinanceReportsService,
    private readonly customerLedger: CustomerLedgerService,
    private readonly salesPosting: SalesPostingService,
  ) {}

  /** Makes sure monthly ledger partitions exist from this month for `monthsAhead` months. */
  async ensurePartitions(monthsAhead = 24): Promise<number> {
    const res = await this.db.execute<{ n: number }>(sql`
      SELECT finance_ensure_gl_partitions(
        date_trunc('month', now())::date,
        (date_trunc('month', now()) + make_interval(months => ${monthsAhead}))::date) AS n`);
    return Number([...res][0]?.n ?? 0);
  }

  /**
   * Checks the tail of every hash chain without walking it from the start: each of the last
   * `tail` registers must hash to what is stored and follow the one before it.
   */
  async verifyChainTails(companyId: string, tail = 200): Promise<{ chainKey: string; problem: string }[]> {
    const chains = await this.db
      .selectDistinct({ chainKey: ledgerRegisters.chainKey })
      .from(ledgerRegisters)
      .where(eq(ledgerRegisters.companyId, companyId));
    const problems: { chainKey: string; problem: string }[] = [];
    for (const { chainKey } of chains) {
      const recent = (
        await this.db
          .select()
          .from(ledgerRegisters)
          .where(and(eq(ledgerRegisters.companyId, companyId), eq(ledgerRegisters.chainKey, chainKey)))
          .orderBy(desc(ledgerRegisters.seq))
          .limit(tail)
      ).reverse();
      let prev: (typeof recent)[number] | undefined;
      for (const r of recent) {
        if (prev && (r.seq !== prev.seq + 1 || r.previousHash !== prev.hash)) {
          problems.push({ chainKey, problem: `Register ${r.seq} does not follow register ${prev.seq}.` });
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
          problems.push({ chainKey, problem: `Register ${r.seq} has been altered.` });
          break;
        }
        prev = r;
      }
    }
    return problems;
  }

  /** The nightly check. Always leaves a trace; reports `ok: false` when anything disagrees. */
  async checkIntegrity(companyId: string): Promise<IntegrityReport> {
    // The last 13 months of whole fiscal periods, so the comparison never cuts a period in half.
    const since = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const periods = await this.db
      .select({ startsOn: accountingPeriods.startsOn, endsOn: accountingPeriods.endsOn })
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.companyId, companyId), gte(accountingPeriods.endsOn, since)))
      .orderBy(asc(accountingPeriods.startsOn));
    const balanceDrift =
      periods.length === 0
        ? 0
        : [...(await this.reports.balanceDrift(companyId, periods[0]!.startsOn, periods[periods.length - 1]!.endsOn))].length;
    const [customerDrift, chainProblems, stuck] = await Promise.all([
      this.customerLedger.drift(companyId),
      this.verifyChainTails(companyId),
      this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM finance_sales_postings WHERE company_id = ${companyId}::uuid AND status = 'failed' AND created_at < now() - interval '1 hour'`),
    ]);
    const stuckSalesPostings = Number([...stuck][0]?.n ?? 0);
    const report: IntegrityReport = {
      ranAt: new Date().toISOString(),
      balanceDrift,
      customerDrift: customerDrift.length,
      chainProblems,
      stuckSalesPostings,
      ok: balanceDrift === 0 && customerDrift.length === 0 && chainProblems.length === 0 && stuckSalesPostings === 0,
    };
    await this.decisions.record({
      companyId,
      subject: { type: 'finance_integrity', id: businessDate() },
      action: report.ok ? 'finance.integrity_ok' : 'finance.integrity_alert',
      actor: { type: 'job', id: 'finance-integrity-check' },
      inputs: { checked: 'balances, customer ledger, hash-chain tails' },
      outcome: { balanceDrift, customerDrift: customerDrift.length, chainProblems, stuckSalesPostings },
    });
    return report;
  }
}
