import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { bankAccounts, bankLedgerEntries, bankReconciliations, bankStatementLines, glAccountBalances } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { centsOf, reconciliationDifference } from '../domain/bank-statement';
import { fromCents } from '../domain/receivables';
import { FinanceError, type FinanceContext } from '../errors';
import { trimToNull } from '@/lib/values';

export interface ReconcileInput {
  bankAccountId: string;
  statementDate: string;
  statementBalance: string;
  /** Only for the first reconciliation of an account: what the bank said it held before the first line. */
  openingBalance?: string | null;
  notes?: string | null;
}

/**
 * Closing the loop: the bank's closing balance, against the opening balance plus every line we
 * have dealt with up to that date. Posted only when they agree to the cent, and from then on the
 * lines it covers cannot be changed. The latest one can be reversed, with a reason.
 */
export class BankReconciliationService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly numbering: NumberSeriesService,
    private readonly reasons: ReasonCodes,
  ) {}

  private async previous(db: Pick<DrizzleDb, 'select'>, bankAccountId: string) {
    const [p] = await db
      .select()
      .from(bankReconciliations)
      .where(and(eq(bankReconciliations.bankAccountId, bankAccountId), eq(bankReconciliations.status, 'posted')))
      .orderBy(desc(bankReconciliations.statementDate), desc(bankReconciliations.postedAt))
      .limit(1);
    return p ?? null;
  }

  /** What posting would do for this date, and what still stands in the way. */
  async preview(companyId: string, bankAccountId: string, statementDate: string) {
    const [account] = await this.db.select().from(bankAccounts).where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, bankAccountId)));
    if (!account) throw new FinanceError('ACCOUNT_NOT_FOUND', 'That bank account does not exist.');
    const prev = await this.previous(this.db, bankAccountId);
    const lines = await this.db
      .select()
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.bankAccountId, bankAccountId), isNull(bankStatementLines.reconciliationId), lte(bankStatementLines.lineDate, statementDate)))
      .orderBy(asc(bankStatementLines.lineDate), asc(bankStatementLines.id));
    const blocking = lines.filter((l) => l.status === 'unmatched' || l.status === 'proposed');
    const closing = lines.filter((l) => l.status === 'matched' || l.status === 'ignored');
    const ignored = closing.filter((l) => l.status === 'ignored');
    const lastBal = [...closing].reverse().find((l) => l.balance !== null);
    const [first] = await this.db.execute<{ opening: string | null }>(sql`
      SELECT (SELECT (l.balance - l.amount)::text FROM bank_statement_lines l WHERE l.bank_account_id = ${bankAccountId}::uuid AND l.balance IS NOT NULL ORDER BY l.line_date, l.id LIMIT 1) AS opening`);
    const [book] = await this.db.select({ n: sql<string>`COALESCE(SUM(${bankLedgerEntries.amount}), 0)` }).from(bankLedgerEntries).where(and(eq(bankLedgerEntries.bankAccountId, bankAccountId), lte(bankLedgerEntries.postingDate, statementDate)));
    const [out] = await this.db.execute<{ n: string; c: number }>(sql`
      SELECT COALESCE(SUM(e.amount), 0)::text AS n, COUNT(*)::int AS c FROM bank_ledger_entries e
      WHERE e.bank_account_id = ${bankAccountId}::uuid AND e.posting_date <= ${statementDate}::date
        AND NOT EXISTS (SELECT 1 FROM bank_statement_matches m WHERE m.bank_entry_id = e.id AND m.undone_at IS NULL)`);
    // The books carry this bank account in the G/L accounts its payment methods post to.
    const [gl] = await this.db
      .select({ n: sql<string>`COALESCE(SUM(${glAccountBalances.baseDebit} - ${glAccountBalances.baseCredit}), 0)` })
      .from(glAccountBalances)
      .where(sql`${glAccountBalances.accountId} IN (
        SELECT gl_account_id FROM bank_ledger_entries WHERE bank_account_id = ${bankAccountId}::uuid
        UNION SELECT gl_account_id FROM payment_methods WHERE balancing_bank_account_id = ${bankAccountId}::uuid)`);
    const opening = prev ? prev.statementBalance : (first?.opening ?? null);
    const totals = closing.reduce((n, l) => n + centsOf(l.amount), 0);
    return {
      account: { id: account.id, code: account.code, name: account.name, currency: account.currency },
      previous: prev ? { number: prev.number, date: prev.statementDate, balance: prev.statementBalance } : null,
      needsOpening: !prev,
      suggestedOpening: opening,
      suggestedStatementBalance: lastBal?.balance ?? null,
      lineCount: closing.length,
      blockingCount: blocking.length,
      ignoredCount: ignored.length,
      ignoredTotal: fromCents(ignored.reduce((n, l) => n + centsOf(l.amount), 0)),
      linesTotal: fromCents(totals),
      bookBalance: book?.n ?? '0',
      outstandingNet: out?.n ?? '0',
      outstandingCount: out?.c ?? 0,
      glBalance: gl?.n ?? '0',
    };
  }

  async post(ctx: FinanceContext, input: ReconcileInput) {
    return await this.db.transaction(async (tx) => {
      const [account] = await tx.select().from(bankAccounts).where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, input.bankAccountId))).for('update');
      if (!account) throw new FinanceError('ACCOUNT_NOT_FOUND', 'That bank account does not exist.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.statementDate) || input.statementDate > businessDate()) throw new FinanceError('DATE_INVALID', 'The statement date cannot be in the future.');
      let statementCents: number;
      try {
        statementCents = centsOf(input.statementBalance);
      } catch {
        throw new FinanceError('AMOUNT_INVALID', 'The statement balance must be a number with at most 2 decimal places.');
      }
      const prev = await this.previous(tx, account.id);
      if (prev && input.statementDate < prev.statementDate) throw new FinanceError('BEFORE_PREVIOUS', `The last reconciliation (${prev.number}) is to ${prev.statementDate}. Reconcile forward, or reverse it first.`);
      let openingCents: number;
      if (prev) openingCents = centsOf(prev.statementBalance);
      else {
        if (input.openingBalance === undefined || input.openingBalance === null || input.openingBalance === '') throw new FinanceError('OPENING_REQUIRED', 'This is the first reconciliation of this account: enter the balance the bank held before the first line.');
        try {
          openingCents = centsOf(input.openingBalance);
        } catch {
          throw new FinanceError('AMOUNT_INVALID', 'The opening balance must be a number with at most 2 decimal places.');
        }
      }
      const lines = await tx
        .select()
        .from(bankStatementLines)
        .where(and(eq(bankStatementLines.bankAccountId, account.id), isNull(bankStatementLines.reconciliationId), lte(bankStatementLines.lineDate, input.statementDate)))
        .orderBy(asc(bankStatementLines.id))
        .for('update');
      const open = lines.filter((l) => l.status === 'unmatched' || l.status === 'proposed');
      if (open.length > 0) throw new FinanceError('LINES_OPEN', `${open.length} statement line${open.length === 1 ? ' is' : 's are'} not dealt with yet. Match, record or set each aside first.`);
      if (lines.length === 0) throw new FinanceError('NO_LINES', 'There are no statement lines up to that date to reconcile.');
      const sum = reconciliationDifference(openingCents, lines.map((l) => centsOf(l.amount)), statementCents);
      if (sum.difference !== 0) {
        throw new FinanceError('DIFFERENCE', `The bank says ${fromCents(statementCents)}, but the opening balance ${fromCents(openingCents)} plus ${lines.length} line${lines.length === 1 ? '' : 's'} (${fromCents(sum.total)}) comes to ${fromCents(sum.expected)}. The difference is ${fromCents(sum.difference)}. Check the opening balance, the date and the lines.`);
      }
      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('bank_reconciliation', { companyId: ctx.companyId, branchId: undefined, date: businessDate(), document: { kind: 'bank_reconciliation', id }, actor: ctx.actor }, tx);
      const ignored = lines.filter((l) => l.status === 'ignored');
      await tx.insert(bankReconciliations).values({
        id,
        companyId: ctx.companyId,
        bankAccountId: account.id,
        number,
        statementDate: input.statementDate,
        openingBalance: fromCents(openingCents),
        statementBalance: fromCents(statementCents),
        linesTotal: fromCents(sum.total),
        lineCount: lines.length,
        ignoredTotal: fromCents(ignored.reduce((n, l) => n + centsOf(l.amount), 0)),
        notes: trimToNull(input.notes),
        postedBy: ctx.actor.id ?? 'system',
        origin: ctx.origin,
      });
      await tx.update(bankStatementLines).set({ reconciliationId: id }).where(and(eq(bankStatementLines.bankAccountId, account.id), isNull(bankStatementLines.reconciliationId), lte(bankStatementLines.lineDate, input.statementDate), sql`${bankStatementLines.status} IN ('matched','ignored')`));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_reconciliation', id }, action: 'finance.bank_reconciled', actor: ctx.actor, to: 'posted', inputs: { origin: ctx.origin, account: account.code, statementDate: input.statementDate }, outcome: { number, opening: fromCents(openingCents), statement: fromCents(statementCents), lines: lines.length } }, tx);
      return { id, number, lines: lines.length };
    });
  }

  /** Undo the latest reconciliation of an account; its lines can be changed again. */
  async reverse(ctx: FinanceContext, id: string, reason: { code: string; text?: string | null }) {
    const rs = await this.reasons.require(ctx.companyId, reason, 'bank_reconciliation');
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(bankReconciliations).where(and(eq(bankReconciliations.companyId, ctx.companyId), eq(bankReconciliations.id, id))).for('update');
      if (!r) throw new FinanceError('NOT_FOUND', 'That reconciliation does not exist.');
      if (r.status !== 'posted') throw new FinanceError('ALREADY_REVERSED', 'This reconciliation was already reversed.');
      await tx.select().from(bankAccounts).where(eq(bankAccounts.id, r.bankAccountId)).for('update');
      const latest = await this.previous(tx, r.bankAccountId);
      if (latest?.id !== r.id) throw new FinanceError('NOT_LATEST', `Only the latest reconciliation can be reversed (${latest?.number}). Reverse that one first.`);
      await tx.update(bankStatementLines).set({ reconciliationId: null }).where(eq(bankStatementLines.reconciliationId, id));
      await tx.update(bankReconciliations).set({ status: 'reversed', reversedBy: ctx.actor.id, reversedAt: new Date(), reverseReasonCode: rs.code, reverseReasonText: rs.text }).where(eq(bankReconciliations.id, id));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_reconciliation', id }, action: 'finance.bank_reconciliation_reversed', actor: ctx.actor, from: 'posted', to: 'reversed', reason: rs, inputs: { origin: ctx.origin } }, tx);
    });
  }

  async list(companyId: string, bankAccountId: string, limit = 20) {
    return await this.db.select().from(bankReconciliations).where(and(eq(bankReconciliations.companyId, companyId), eq(bankReconciliations.bankAccountId, bankAccountId))).orderBy(desc(bankReconciliations.statementDate), desc(bankReconciliations.postedAt)).limit(limit);
  }
}
