import { and, desc, eq, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankLedgerEntries,
  cashCounts,
  financeSettings,
  glAccounts,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { countProblem, totalOfCount, totalTyped, type DenominationInput } from '@/lib/cash-count';
import { fromCents } from '../domain/receivables';
import type { PostingRequest } from '../domain/types';
import { NO_SPECIAL_PERMISSIONS, type PostingEngine, type PostingPermissions } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';
import type { FxService } from '../fx-service';
import type { BankStatementService } from './bank-statement-service';

/** The cash G/L account to write against: the one asked for, or the only one there is. */
function pickCashGl<T extends { glId: string }>(
  choices: T[],
  asked: string | undefined,
): T | undefined {
  if (has(asked)) return choices.find((c) => c.glId === asked);
  return choices.length === 1 ? choices[0] : undefined;
}

import { has, required } from '@/lib/values';

export interface CountInput {
  bankAccountId: string;
  countDate: string;
  /** Notes and coins counted one by one, or a total typed in (one of the two). */
  denominations?: DenominationInput[];
  total?: string;
  /** Where a difference is written (any open posting account; usually a cash over/short expense). */
  varianceGlAccountId?: string;
  /** Which cash G/L account the account's methods post to, when there are several. */
  glAccountId?: string;
  note?: string;
  permissions?: PostingPermissions;
}

/** Counting the cash in a drawer against the books. A count is kept for good; a difference is written to the books at once. */
export class CashCountService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly numbering: NumberSeriesService,
    private readonly statements: BankStatementService,
    private readonly fx: FxService,
  ) {}

  private async cashAccount(db: Pick<DrizzleDb, 'select'>, companyId: string, id: string) {
    const [a] = await db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, id)));
    if (a === undefined)
      throw new FinanceError('ACCOUNT_NOT_FOUND', 'That account does not exist.');
    if (a.kind !== 'cash')
      throw new FinanceError(
        'NOT_CASH',
        `${a.code} is not a cash account. Counts are for the cash you hold in drawers and safes.`,
      );
    if (a.blocked) throw new FinanceError('ACCOUNT_BLOCKED', `${a.code} is blocked.`);
    return a;
  }

  /** What the books say the account held at the end of a day. */
  async bookBalanceCents(
    db: Pick<DrizzleDb, 'select'>,
    bankAccountId: string,
    date: string,
  ): Promise<number> {
    const [row] = await db
      .select({ n: sql<string>`COALESCE(SUM(${bankLedgerEntries.amount}), 0)::text` })
      .from(bankLedgerEntries)
      .where(
        and(
          eq(bankLedgerEntries.bankAccountId, bankAccountId),
          lte(bankLedgerEntries.postingDate, date),
        ),
      );
    return Math.round(Number(row?.n ?? '0') * 100);
  }

  /** The cash accounts to count, with what the books say each holds and the last count. */
  async overview(companyId: string) {
    const accounts = await this.db
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.kind, 'cash'),
          eq(bankAccounts.blocked, false),
        ),
      )
      .orderBy(bankAccounts.code);
    const today = businessDate();
    return await Promise.all(
      accounts.map(async (a) => {
        const [book, last] = await Promise.all([
          this.bookBalanceCents(this.db, a.id, today),
          this.db
            .select()
            .from(cashCounts)
            .where(eq(cashCounts.bankAccountId, a.id))
            .orderBy(desc(cashCounts.countDate), desc(cashCounts.createdAt))
            .limit(1),
        ]);
        return {
          id: a.id,
          code: a.code,
          name: a.name,
          currency: a.currency,
          bookCents: book,
          last: last[0] ?? null,
        };
      }),
    );
  }

  /** What a count would be measured against, and what was used for the difference last time, so the form can show the book figure. */
  async preview(companyId: string, bankAccountId: string, date: string) {
    const a = await this.cashAccount(this.db, companyId, bankAccountId);
    if (date > businessDate())
      throw new FinanceError(
        'DATE_IN_FUTURE',
        'Cash cannot be counted on a day that has not come.',
      );
    const [book, last, choices] = await Promise.all([
      this.bookBalanceCents(this.db, a.id, date),
      this.db
        .select({ gl: cashCounts.varianceGlAccountId, no: glAccounts.no, name: glAccounts.name })
        .from(cashCounts)
        .innerJoin(glAccounts, eq(glAccounts.id, cashCounts.varianceGlAccountId))
        .where(
          and(
            eq(cashCounts.bankAccountId, a.id),
            sql`${cashCounts.varianceGlAccountId} IS NOT NULL`,
          ),
        )
        .orderBy(desc(cashCounts.createdAt))
        .limit(1),
      this.statements.chargeGlChoices(companyId, a.id),
    ]);
    return {
      currency: a.currency,
      bookCents: book,
      lastVariance:
        last[0]?.gl === null || last[0] === undefined
          ? null
          : { id: last[0].gl, label: `${last[0].no} ${last[0].name}` },
      glChoiceCount: choices.length,
    };
  }

  /** Counts of one account, newest first, a page at a time. The cursor is the database's own text for the time, so no microsecond is lost. */
  async list(companyId: string, bankAccountId: string, before?: string, limit = 20) {
    await this.cashAccount(this.db, companyId, bankAccountId);
    const rows = await this.db
      .select({ row: cashCounts, cursor: sql<string>`${cashCounts.createdAt}::text` })
      .from(cashCounts)
      .where(
        and(
          eq(cashCounts.companyId, companyId),
          eq(cashCounts.bankAccountId, bankAccountId),
          has(before) ? sql`${cashCounts.createdAt} < ${before}::timestamptz` : undefined,
        ),
      )
      .orderBy(desc(cashCounts.createdAt))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      rows: page.map((r) => r.row),
      next: rows.length > limit ? (page.at(-1)?.cursor ?? null) : null,
    };
  }

  /**
   * Records a count. The books' figure is read inside the same transaction as the count (with the account locked so two counts
   * of one drawer cannot interleave), and a difference is written to the books on the count date.
   */
  async post(
    ctx: FinanceContext,
    input: CountInput,
  ): Promise<{ id: string; number: string; difference: string; gl: boolean }> {
    const permissions = input.permissions ?? NO_SPECIAL_PERMISSIONS;
    let counted: { cents: number; rows: { value: string; count: number }[] };
    if (input.denominations !== undefined) {
      const c = totalOfCount(input.denominations);
      if (!c.ok) throw new FinanceError('COUNT_INVALID', c.error);
      counted = c.value;
    } else if (input.total !== undefined) {
      const t = totalTyped(input.total);
      if (!t.ok) throw new FinanceError('COUNT_INVALID', t.error);
      counted = { cents: t.value, rows: [] };
    } else {
      throw new FinanceError(
        'COUNT_INVALID',
        'Enter what was counted: the notes and coins, or the total.',
      );
    }
    if (input.countDate > businessDate())
      throw new FinanceError(
        'DATE_IN_FUTURE',
        'Cash cannot be counted on a day that has not come.',
      );
    return await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT 1 FROM bank_accounts WHERE id = ${input.bankAccountId}::uuid AND company_id = ${ctx.companyId}::uuid FOR UPDATE`,
      );
      const account = await this.cashAccount(tx, ctx.companyId, input.bankAccountId);
      const expected = await this.bookBalanceCents(tx, account.id, input.countDate);
      const diff = counted.cents - expected;
      const note = (input.note ?? '').trim();
      const problem = countProblem(diff, note, has(input.varianceGlAccountId));
      if (problem !== null) throw new FinanceError('COUNT_INCOMPLETE', problem);

      let variance: { id: string } | null = null;
      if (diff !== 0) {
        const [gl] = await tx
          .select()
          .from(glAccounts)
          .where(
            and(
              eq(glAccounts.companyId, ctx.companyId),
              eq(glAccounts.id, required(input.varianceGlAccountId)),
            ),
          );
        if (gl?.type !== 'posting' || gl.blocked)
          throw new FinanceError(
            'VARIANCE_ACCOUNT_INVALID',
            'Choose an open account to write the difference to.',
          );
        variance = { id: gl.id };
      }

      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign(
        'cash_count',
        {
          companyId: ctx.companyId,
          branchId: undefined,
          date: businessDate(),
          document: { kind: 'cash_count', id },
          actor: ctx.actor,
        },
        tx,
      );
      let registerId: string | null = null;
      let bankEntryId: number | null = null;
      let live = false;
      if (diff !== 0 && variance !== null) {
        const choices = await this.statements.chargeGlChoices(ctx.companyId, account.id);
        if (choices.length === 0)
          throw new FinanceError(
            'NO_METHOD',
            `No payment method pays into ${account.code}, so there is no G/L account to write the difference against. Add one under Settings → Payments.`,
          );
        const cashGl = pickCashGl(choices, input.glAccountId);
        if (cashGl === undefined)
          throw new FinanceError(
            'GL_CHOICE_NEEDED',
            has(input.glAccountId)
              ? 'That G/L account is not used by any payment method of this cash account.'
              : `Several G/L accounts are used for ${account.code}: choose the one the cash is held in.`,
          );
        const issues = await this.engine.dateIssues(
          tx,
          ctx.companyId,
          input.countDate,
          permissions,
        );
        if (issues.length > 0)
          throw new FinanceError(issues[0].code, issues.map((i) => i.message).join(' '));
        const [s] = await tx
          .select()
          .from(financeSettings)
          .where(eq(financeSettings.companyId, ctx.companyId));
        live = s?.salesGlGoLive != null && input.countDate >= s.salesGlGoLive;
        const abs = Math.abs(diff);
        if (live && s !== undefined) {
          const foreign = account.currency.toUpperCase() !== s.baseCurrency;
          const rate = foreign
            ? await this.fx.requireRate(tx, ctx.companyId, account.currency, input.countDate)
            : '1';
          const short = diff < 0;
          const req: PostingRequest = {
            companyId: ctx.companyId,
            idempotencyKey: `cash_count:${id}`,
            postingDate: input.countDate,
            documentType: 'cash_count',
            documentNo: number,
            description:
              `Cash count ${number}: ${short ? 'short' : 'over'} ${fromCents(abs)}`.slice(0, 200),
            currency: foreign ? account.currency.toUpperCase() : s.baseCurrency,
            rate,
            rateSource: foreign ? 'manual' : 'base',
            lines: [
              {
                accountId: short ? variance.id : cashGl.glId,
                debit: fromCents(abs),
                credit: '0',
                description: short ? note.slice(0, 200) : `Count ${number}`,
                ...(short ? {} : { sourceLedger: 'bank' as const, sourceEntryId: account.id }),
              },
              {
                accountId: short ? cashGl.glId : variance.id,
                debit: '0',
                credit: fromCents(abs),
                description: short ? `Count ${number}` : note.slice(0, 200),
                ...(short ? { sourceLedger: 'bank' as const, sourceEntryId: account.id } : {}),
              },
            ],
            chainKey: 'general',
            origin: ctx.origin,
            source: { type: 'cash_count', id },
            postedBy: 'engine',
          };
          registerId = (await this.engine.post(req, permissions, tx)).registerId;
        }
        // The cash account's own ledger moves to what was counted, whether or not the books are live.
        const [entry] = await tx
          .insert(bankLedgerEntries)
          .values({
            companyId: ctx.companyId,
            bankAccountId: account.id,
            glAccountId: cashGl.glId,
            postingDate: input.countDate,
            documentType: 'cash_count',
            documentNo: number,
            documentId: id,
            description: `Cash count ${diff < 0 ? 'short' : 'over'}: ${note}`.slice(0, 300),
            amount: fromCents(diff),
            currency: account.currency,
            registerId,
            createdBy: ctx.actor.id,
          })
          .returning({ id: bankLedgerEntries.id });
        bankEntryId = entry.id;
      }
      await tx.insert(cashCounts).values({
        id,
        companyId: ctx.companyId,
        bankAccountId: account.id,
        number,
        countDate: input.countDate,
        currency: account.currency,
        denominations: counted.rows,
        countedAmount: fromCents(counted.cents),
        expectedAmount: fromCents(expected),
        difference: fromCents(diff),
        varianceGlAccountId: variance?.id ?? null,
        note: note === '' ? null : note,
        registerId,
        bankEntryId,
        countedBy: ctx.actor.id ?? 'system',
      });
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'cash_count', id },
          action: 'finance.cash_counted',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, account: account.code, date: input.countDate },
          outcome: {
            number,
            counted: fromCents(counted.cents),
            expected: fromCents(expected),
            difference: fromCents(diff),
            gl: live,
          },
        },
        tx,
      );
      return { id, number, difference: fromCents(diff), gl: live };
    });
  }
}
