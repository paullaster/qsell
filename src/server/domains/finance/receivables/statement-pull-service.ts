import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankStatementImports,
  paymentProviderConfigs,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import {
  checkPullRange,
  type PulledLine,
  type StatementPullRequest,
  type StatementPullResult,
} from '@/server/domains/payments/statement-pull';
import { finish, type ParsedLine } from '../domain/bank-statement';
import { FinanceError, type FinanceContext } from '../errors';
import type { BankStatementService } from './bank-statement-service';

import { has } from '@/lib/values';

/** Whatever can ask a connected bank for a statement (the payment engine). */
export interface StatementSource {
  pullStatement(providerId: string, request: StatementPullRequest): Promise<StatementPullResult>;
}

/** The lines in the order things happened. Banks usually answer newest first; the order they came in settles lines of one day. */
export function chronological(lines: readonly PulledLine[]): PulledLine[] {
  const first = lines.at(0);
  const last = lines.at(-1);
  const newestFirst = first !== undefined && last !== undefined && first.date > last.date;
  const ordered = newestFirst ? [...lines].reverse() : [...lines];
  return ordered.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Pulling a bank account's statement through the bank's own API. The lines go through the same checks, de-duplication and matching
 * as a file a person imports, so pulling the same days twice, or overlapping days, keeps each line once.
 */
export class StatementPullService {
  /** Attached after the payment engine is built (it needs finance to settle payments). */
  source: StatementSource | null = null;

  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly statements: BankStatementService,
  ) {}

  /** Whether an account can be pulled, and from what: a connected bank and the number the bank knows it by. */
  async setup(companyId: string, bankAccountId: string) {
    const [a] = await this.db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, bankAccountId)));
    if (a === undefined)
      throw new FinanceError('ACCOUNT_NOT_FOUND', 'That bank account does not exist.');
    const number = (a.details.accountNumber ?? '').trim();
    const [p] =
      a.providerConfigId === null
        ? []
        : await this.db
            .select()
            .from(paymentProviderConfigs)
            .where(
              and(
                eq(paymentProviderConfigs.companyId, companyId),
                eq(paymentProviderConfigs.id, a.providerConfigId),
              ),
            );
    const last = await this.db
      .select({
        at: bankStatementImports.createdAt,
        from: bankStatementImports.dateFrom,
        to: bankStatementImports.dateTo,
        lines: bankStatementImports.lineCount,
      })
      .from(bankStatementImports)
      .where(
        and(eq(bankStatementImports.bankAccountId, a.id), eq(bankStatementImports.format, 'pull')),
      )
      .orderBy(desc(bankStatementImports.createdAt))
      .limit(1);
    return {
      account: a,
      provider: p ?? null,
      accountNumber: number,
      ready: p !== undefined && number !== '',
      last: last[0] ?? null,
    };
  }

  async pull(
    ctx: FinanceContext,
    bankAccountId: string,
    range: { fromDate: string; toDate: string },
  ) {
    const bad = checkPullRange(range.fromDate, range.toDate, businessDate());
    if (bad !== null) throw new FinanceError('RANGE_INVALID', bad);
    const s = await this.setup(ctx.companyId, bankAccountId);
    if (s.account.blocked) throw new FinanceError('BANK_BLOCKED', `${s.account.code} is blocked.`);
    if (s.provider === null)
      throw new FinanceError(
        'NO_SOURCE',
        `${s.account.code} is not connected to a bank. Choose the bank connection for it (Finance → Bank accounts).`,
      );
    if (s.accountNumber === '')
      throw new FinanceError(
        'NO_ACCOUNT_NUMBER',
        `${s.account.code} has no account number, which the bank needs to find it. Add it (Finance → Bank accounts).`,
      );
    if (this.source === null)
      throw new FinanceError('NO_SOURCE', 'Statements cannot be pulled right now.');
    const countryCode =
      typeof s.provider.settings.countryCode === 'string' &&
      s.provider.settings.countryCode.trim() !== ''
        ? s.provider.settings.countryCode.trim().toUpperCase()
        : 'KE';
    const request: StatementPullRequest = {
      accountNumber: s.accountNumber,
      countryCode,
      fromDate: range.fromDate,
      toDate: range.toDate,
    };
    const got = await this.source.pullStatement(s.provider.id, request);
    if (!got.ok) {
      await this.decisions.record({
        companyId: ctx.companyId,
        subject: { type: 'bank_account', id: s.account.id },
        action: 'finance.statement_pull_failed',
        actor: ctx.actor,
        inputs: { origin: ctx.origin, from: range.fromDate, to: range.toDate },
        outcome: { error: got.error, retryable: got.retryable },
      });
      throw new FinanceError(got.retryable ? 'PULL_FAILED_RETRY' : 'PULL_FAILED', got.error);
    }
    if (got.lines.length === 0)
      return {
        lines: 0,
        duplicates: 0,
        autoMatched: 0,
        proposed: 0,
        truncated: false,
        pages: got.pages,
        empty: true,
      };
    const ordered = chronological(got.lines);
    const lines: ParsedLine[] = ordered.map((l, i) => ({
      lineNo: i + 1,
      date: l.date,
      description: l.description,
      reference: l.reference,
      counterparty: l.counterparty,
      amountCents: l.amountCents,
      balanceCents: l.balanceCents,
    }));
    const parsed = finish(lines, [], [], []);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          a: s.account.id,
          from: range.fromDate,
          to: range.toDate,
          l: parsed.lines.map((l) => [
            l.date,
            l.amountCents,
            l.reference,
            l.description,
            l.balanceCents,
          ]),
        }),
      )
      .digest('hex');
    const name = `${s.provider.displayName} ${range.fromDate} to ${range.toDate}`;
    try {
      const done = await this.statements.importParsed(ctx, s.account, parsed, {
        fileName: name,
        fileHash: fingerprint,
        format: 'pull',
      });
      return {
        lines: done.lines,
        duplicates: done.duplicates,
        autoMatched: done.autoMatched,
        proposed: done.proposed,
        truncated: got.truncated,
        pages: got.pages,
        empty: false,
      };
    } catch (error) {
      // Days already kept, pulled again: nothing new, and nothing wrong.
      if (
        error instanceof FinanceError &&
        (error.code === 'NOTHING_NEW' || error.code === 'ALREADY_IMPORTED')
      ) {
        return {
          lines: 0,
          duplicates: parsed.lines.length,
          autoMatched: 0,
          proposed: 0,
          truncated: got.truncated,
          pages: got.pages,
          empty: false,
        };
      }
      throw error;
    }
  }
}

export const hasProviderAndNumber = (s: { provider: unknown; accountNumber: string }): boolean =>
  s.provider !== null && has(s.accountNumber);
