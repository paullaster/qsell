import { randomInt, randomUUID } from 'node:crypto';
import { and, eq, inArray, lte, gte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  accountingPeriods,
  financeSettings,
  glAccounts,
  glEntries,
  ledgerRegisterChains,
  ledgerRegisters,
  registerReversals,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { currentContext } from '@/server/kernel/context';
import { formatAmount } from './domain/amount';
import { GENESIS_HASH, registerHash } from './domain/hash';
import {
  checkPostingDate,
  reverseLines,
  validatePosting,
  type AccountFacts,
  type PeriodFacts,
  type PostingPolicy,
  type PreparedPosting,
} from './domain/journal';
import type { Issue, JournalLineInput, PostingRequest } from './domain/types';

import { has } from '@/lib/has';
import { emptyToNull } from '@/lib/values';

export type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** What the caller (the entry point that checked permissions) allows this posting to do. */
export interface PostingPermissions {
  canPostSoftClosed: boolean;
  canPostControlAccounts: boolean;
}

export const NO_SPECIAL_PERMISSIONS: PostingPermissions = {
  canPostSoftClosed: false,
  canPostControlAccounts: false,
};

/** The balances table's way of saying "no dimensions". */
export const NIL_DIMENSION_SET = '00000000-0000-0000-0000-000000000000';
/** Running-balance rows per account and period: a posting picks one at random, so concurrent
 * postings to a hot account (cash, sales) rarely wait on the same row. Reads sum them. */
const SHARDS = 64;

export class PostingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

export interface PostedRegister {
  registerId: string;
  chainKey: string;
  seq: number;
  hash: string;
  entryCount: number;
  /** True when this idempotency key had already been posted and nothing new was written. */
  replayed: boolean;
}

export interface PostingPreview {
  ok: boolean;
  issues: Issue[];
  periodId: string | null;
  lines: {
    line: number;
    accountId: string;
    accountNo: string;
    accountName: string;
    debit: string;
    credit: string;
    baseDebit: string;
    baseCredit: string;
  }[];
  totalDebit: string;
  totalCredit: string;
}

function pickShard(): number {
  return randomInt(SHARDS);
}

/**
 * The one door for money. Everything that changes a ledger goes through here: it validates,
 * numbers (gap-free per chain), hashes, writes the register, the entries and the running
 * balances, and records why, all in one transaction. Nothing else writes `gl_entries`.
 */
export class PostingEngine {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  // ── policy ───────────────────────────────────────────────────────────────

  private async loadPolicy(
    db: Pick<DrizzleDb, 'select'>,
    req: PostingRequest,
    perms: PostingPermissions,
  ): Promise<{ policy: PostingPolicy; period: PeriodFacts | null }> {
    const accountIds = [...new Set(req.lines.map((l) => l.accountId))];
    const [accounts, periods, settings] = await Promise.all([
      accountIds.length === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(glAccounts)
            .where(and(eq(glAccounts.companyId, req.companyId), inArray(glAccounts.id, accountIds))),
      db
        .select()
        .from(accountingPeriods)
        .where(
          and(
            eq(accountingPeriods.companyId, req.companyId),
            lte(accountingPeriods.startsOn, req.postingDate),
            gte(accountingPeriods.endsOn, req.postingDate),
          ),
        )
        .limit(1),
      db.select().from(financeSettings).where(eq(financeSettings.companyId, req.companyId)).limit(1),
    ]);
    const facts = new Map<string, AccountFacts>(
      accounts.map((a) => [
        a.id,
        {
          id: a.id,
          no: a.no,
          name: a.name,
          type: a.type,
          blocked: a.blocked,
          directPosting: a.directPosting,
          postingSource: a.postingSource,
          currencyPolicy: a.currencyPolicy,
          dimensionRule: a.dimensionRule,
          used: a.usedAt !== null,
        },
      ]),
    );
    const p = periods[0];
    const period: PeriodFacts | null = p
      ? { id: p.id, status: p.status, startsOn: p.startsOn, endsOn: p.endsOn }
      : null;
    const s = settings[0];
    if (s === undefined) {
      throw new PostingError(
        'FINANCE_NOT_SET_UP',
        'Finance has not been set up yet. Apply a chart of accounts first.',
      );
    }
    return {
      period,
      policy: {
        baseCurrency: s.baseCurrency,
        period,
        window: { from: s.postingFrom, to: s.postingTo },
        canPostSoftClosed: perms.canPostSoftClosed,
        canPostControlAccounts: perms.canPostControlAccounts,
        accounts: facts,
      },
    };
  }

  /**
   * The date rules on their own (period open, inside the posting window), for sub-ledger
   * documents that are dated in the books even when they do not post to the general ledger.
   * Returns the reasons it is refused; empty means allowed.
   */
  async dateIssues(
    db: Pick<DrizzleDb, 'select'>,
    companyId: string,
    postingDate: string,
    perms: PostingPermissions = NO_SPECIAL_PERMISSIONS,
  ): Promise<Issue[]> {
    const { policy } = await this.loadPolicy(
      db,
      { companyId, postingDate, lines: [] } as unknown as PostingRequest,
      perms,
    );
    return checkPostingDate(postingDate, policy);
  }

  /** Runs every check and returns the entries that WOULD be written. Writes nothing. */
  async preview(
    req: PostingRequest,
    perms: PostingPermissions = NO_SPECIAL_PERMISSIONS,
  ): Promise<PostingPreview> {
    const { policy, period } = await this.loadPolicy(this.db, req, perms);
    const result = validatePosting(req, policy);
    if (!result.ok) {
      return {
        ok: false,
        issues: result.issues,
        periodId: period?.id ?? null,
        lines: [],
        totalDebit: '0.0000',
        totalCredit: '0.0000',
      };
    }
    const lines = result.posting.lines.map((l) => {
      const a = policy.accounts.get(l.accountId)!;
      return {
        line: l.index,
        accountId: l.accountId,
        accountNo: a.no,
        accountName: a.name,
        debit: formatAmount(l.debit),
        credit: formatAmount(l.credit),
        baseDebit: formatAmount(l.baseDebit),
        baseCredit: formatAmount(l.baseCredit),
      };
    });
    return {
      ok: true,
      issues: [],
      periodId: period?.id ?? null,
      lines,
      totalDebit: formatAmount(result.posting.totalDebit),
      totalCredit: formatAmount(result.posting.totalCredit),
    };
  }

  // ── post ─────────────────────────────────────────────────────────────────

  /**
   * Posts in `tx` when given (the caller's own transaction, so a document and its postings
   * commit together); otherwise opens one. A repeated idempotency key returns the first result.
   */
  async post(
    req: PostingRequest,
    perms: PostingPermissions = NO_SPECIAL_PERMISSIONS,
    tx?: Tx,
  ): Promise<PostedRegister> {
    if (tx) return await this.postIn(tx, req, perms);
    try {
      return await this.db.transaction((t) => this.postIn(t, req, perms));
    } catch (error) {
      if (isUniqueViolation(error, 'ledger_registers_idem_uidx')) {
        // Two callers raced on the same key: the loser reads the winner's register.
        const existing = await this.findByKey(this.db, req.companyId, req.idempotencyKey);
        if (existing) return { ...existing, replayed: true };
      }
      throw error;
    }
  }

  private async findByKey(
    db: Pick<DrizzleDb, 'select'>,
    companyId: string,
    key: string,
  ): Promise<Omit<PostedRegister, 'replayed'> | null> {
    const [row] = await db
      .select()
      .from(ledgerRegisters)
      .where(and(eq(ledgerRegisters.companyId, companyId), eq(ledgerRegisters.idempotencyKey, key)))
      .limit(1);
    if (!row) return null;
    return {
      registerId: row.id,
      chainKey: row.chainKey,
      seq: row.seq,
      hash: row.hash,
      entryCount: row.lineCount,
    };
  }

  private async postIn(tx: Tx, req: PostingRequest, perms: PostingPermissions): Promise<PostedRegister> {
    const [existing, loaded] = await Promise.all([
      this.findByKey(tx, req.companyId, req.idempotencyKey),
      this.loadPolicy(tx, req, perms),
    ]);
    if (existing) return { ...existing, replayed: true };
    const { policy, period } = loaded;
    const result = validatePosting(req, policy);
    if (!result.ok) {
      throw new PostingError(
        result.issues[0]?.code ?? 'INVALID',
        result.issues.map((i) => (i.line !== null && i.line !== undefined && i.line !== 0 ? `Line ${i.line}: ${i.message}` : i.message)).join(' '),
        result.issues,
      );
    }
    const prepared: PreparedPosting = result.posting;
    const periodId = period!.id;

    // Take the next number on this chain in one statement. The row stays locked until commit,
    // so registers of one chain are serialised here and other chains proceed.
    const chainRows = await tx
      .insert(ledgerRegisterChains)
      .values({ companyId: req.companyId, chainKey: req.chainKey, lastSeq: 1, lastHash: GENESIS_HASH })
      .onConflictDoUpdate({
        target: [ledgerRegisterChains.companyId, ledgerRegisterChains.chainKey],
        set: { lastSeq: sql`${ledgerRegisterChains.lastSeq} + 1` },
      })
      .returning({ lastSeq: ledgerRegisterChains.lastSeq, lastHash: ledgerRegisterChains.lastHash });
    const chain = chainRows[0];
    if (!chain) throw new PostingError('CHAIN_MISSING', 'Could not open the register chain.');

    const seq = chain.lastSeq;
    const totalDebit = formatAmount(prepared.totalDebit);
    const totalCredit = formatAmount(prepared.totalCredit);
    const hash = registerHash(chain.lastHash, {
      companyId: req.companyId,
      chainKey: req.chainKey,
      seq,
      idempotencyKey: req.idempotencyKey,
      postingDate: req.postingDate,
      currency: req.currency,
      totalDebit,
      totalCredit,
      lineCount: prepared.lines.length,
      lines: prepared.lines.map((l) => ({
        accountId: l.accountId,
        debit: formatAmount(l.debit),
        credit: formatAmount(l.credit),
        dimensionSetId: l.dimensionSetId,
      })),
      reversalOf: req.reversalOf ?? null,
    });

    const ctx = currentContext();
    const registerId = randomUUID();
    const shard = pickShard();

    // Running balances: one additive upsert, rows sorted so concurrent postings lock in the
    // same order and cannot deadlock each other.
    const bucket = new Map<string, { account: string; dim: string; d: bigint; c: bigint; n: number }>();
    for (const l of prepared.lines) {
      const dim = l.dimensionSetId ?? NIL_DIMENSION_SET;
      const key = `${l.accountId}|${dim}`;
      const b = bucket.get(key) ?? { account: l.accountId, dim, d: 0n, c: 0n, n: 0 };
      b.d += l.baseDebit;
      b.c += l.baseCredit;
      b.n += 1;
      bucket.set(key, b);
    }
    const rows = [...bucket.values()].sort((a, b) =>
      a.account === b.account ? a.dim.localeCompare(b.dim) : a.account.localeCompare(b.account),
    );
    const values = sql.join(
      rows.map(
        (r) =>
          sql`(${req.companyId}::uuid, ${r.account}::uuid, ${periodId}::uuid, ${r.dim}::uuid, ${shard}::smallint, ${formatAmount(r.d)}::numeric, ${formatAmount(r.c)}::numeric, ${r.n}::bigint)`,
      ),
      sql`, `,
    );
    const unusedAccounts = [...new Set(prepared.lines.map((l) => l.accountId))].filter(
      (id) => (policy.accounts.get(id)?.used) !== true,
    );

    // None of these depends on another's result, so they are sent together on the one
    // connection instead of one round trip each.
    await Promise.all([
      tx.insert(ledgerRegisters).values({
        id: registerId,
        companyId: req.companyId,
        chainKey: req.chainKey,
        seq,
        idempotencyKey: req.idempotencyKey,
        documentType: req.documentType,
        documentNo: req.documentNo,
        description: req.description ?? null,
        postingDate: req.postingDate,
        documentDate: req.documentDate ?? req.postingDate,
        periodId,
        currency: req.currency,
        rate: req.currency === policy.baseCurrency ? '1' : req.rate,
        rateSource: req.currency === policy.baseCurrency ? 'base' : req.rateSource,
        totalDebit,
        totalCredit,
        baseTotalDebit: formatAmount(prepared.baseTotalDebit),
        baseTotalCredit: formatAmount(prepared.baseTotalCredit),
        lineCount: prepared.lines.length,
        branchId: req.branchId ?? null,
        sourceType: req.source?.type ?? null,
        sourceId: req.source?.id ?? null,
        reversalOfId: req.reversalOf ?? null,
        postedByType: ctx.actor.type,
        postedById: ctx.actor.id,
        reasonCode: req.reasonCode ?? null,
        reasonText: req.reasonText ?? null,
        origin: { ...req.origin, correlationId: ctx.correlationId },
        previousHash: chain.lastHash,
        hash,
      }),
      tx.insert(glEntries).values(
        prepared.lines.map((l) => ({
          postingDate: req.postingDate,
          companyId: req.companyId,
          registerId,
          lineNo: l.index,
          accountId: l.accountId,
          debit: formatAmount(l.debit),
          credit: formatAmount(l.credit),
          baseDebit: formatAmount(l.baseDebit),
          baseCredit: formatAmount(l.baseCredit),
          currency: l.currency,
          description: l.description ?? req.description ?? null,
          dimensionSetId: l.dimensionSetId,
          documentType: req.documentType,
          documentNo: req.documentNo,
          branchId: req.branchId ?? null,
          sourceLedger: l.sourceLedger,
          sourceEntryId: l.sourceEntryId,
        })),
      ),
      tx.execute(sql`
        INSERT INTO gl_account_balances
          (company_id, account_id, period_id, dimension_set_id, shard, base_debit, base_credit, entry_count)
        VALUES ${values}
        ON CONFLICT (company_id, account_id, period_id, dimension_set_id, shard) DO UPDATE SET
          base_debit = gl_account_balances.base_debit + EXCLUDED.base_debit,
          base_credit = gl_account_balances.base_credit + EXCLUDED.base_credit,
          entry_count = gl_account_balances.entry_count + EXCLUDED.entry_count`),
      // The account is now "used": its number, type and currency freeze (database trigger).
      unusedAccounts.length === 0
        ? Promise.resolve()
        : tx
            .update(glAccounts)
            .set({ usedAt: sql`now()` })
            .where(
              and(
                eq(glAccounts.companyId, req.companyId),
                inArray(glAccounts.id, unusedAccounts),
                sql`${glAccounts.usedAt} IS NULL`,
              ),
            ),
      tx
        .update(ledgerRegisterChains)
        .set({ lastHash: hash })
        .where(
          and(
            eq(ledgerRegisterChains.companyId, req.companyId),
            eq(ledgerRegisterChains.chainKey, req.chainKey),
          ),
        ),
      this.decisions.record(
        {
          companyId: req.companyId,
          subject: { type: 'ledger_register', id: registerId },
          action: has(req.reversalOf) ? 'finance.register_reversed' : 'finance.register_posted',
          reason:
            has(req.reasonCode) || has(req.reasonText)
              ? { code: req.reasonCode ?? undefined, text: req.reasonText }
              : undefined,
          inputs: {
            origin: req.origin,
            documentType: req.documentType,
            documentNo: req.documentNo,
            postingDate: req.postingDate,
            currency: req.currency,
            source: req.source ?? null,
            reversalOf: req.reversalOf ?? null,
          },
          outcome: { chainKey: req.chainKey, seq, totalDebit, totalCredit, lines: prepared.lines.length },
        },
        tx,
      ),
    ]);

    return { registerId, chainKey: req.chainKey, seq, hash, entryCount: prepared.lines.length, replayed: false };
  }

  // ── reverse ──────────────────────────────────────────────────────────────

  /**
   * Posts the mirror of a register on `postingDate`, linked to the original. A register can be
   * reversed once, and a reversal cannot itself be reversed (post the original again instead).
   */
  async reverse(input: {
    companyId: string;
    registerId: string;
    postingDate: string;
    reasonCode: string;
    reasonText?: string | null;
    origin: PostingRequest['origin'];
    permissions?: PostingPermissions;
    /** Reverse inside the caller's transaction (a document and its reversal commit together). */
    tx?: Tx;
  }): Promise<PostedRegister> {
    const perms = input.permissions ?? NO_SPECIAL_PERMISSIONS;
    if (input.reasonCode.trim() === '' && !has((input.reasonText ?? '').trim())) {
      throw new PostingError('REASON_REQUIRED', 'A reason is required to reverse a posting.');
    }
    const run = <T,>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
      input.tx ? fn(input.tx) : this.db.transaction(fn);
    return await run(async (tx) => {
      const [original] = await tx
        .select()
        .from(ledgerRegisters)
        .where(and(eq(ledgerRegisters.companyId, input.companyId), eq(ledgerRegisters.id, input.registerId)))
        .limit(1);
      if (!original) throw new PostingError('NOT_FOUND', 'That posting does not exist.');
      if (has(original.reversalOfId)) {
        throw new PostingError('IS_REVERSAL', 'A reversal cannot be reversed; post the original again instead.');
      }
      const [already] = await tx
        .select()
        .from(registerReversals)
        .where(eq(registerReversals.originalId, original.id))
        .limit(1);
      if (already) throw new PostingError('ALREADY_REVERSED', 'This posting has already been reversed.');

      const entries = await tx
        .select()
        .from(glEntries)
        .where(and(eq(glEntries.registerId, original.id), eq(glEntries.postingDate, original.postingDate)));
      const lines: JournalLineInput[] = reverseLines(
        entries
          .sort((a, b) => a.lineNo - b.lineNo)
          .map((e) => ({
            accountId: e.accountId,
            debit: e.debit,
            credit: e.credit,
            description: `Reversal: ${e.description ?? original.documentNo}`,
            dimensionSetId: e.dimensionSetId,
            currency: e.currency,
          })),
      );
      const posted = await this.postIn(
        tx,
        {
          companyId: input.companyId,
          idempotencyKey: `reversal:${original.id}`,
          postingDate: input.postingDate,
          documentType: original.documentType,
          documentNo: original.documentNo,
          description: `Reversal of ${original.documentNo}`,
          currency: original.currency,
          rate: original.rate,
          rateSource: original.rateSource as PostingRequest['rateSource'],
          lines,
          chainKey: original.chainKey,
          branchId: original.branchId,
          reasonCode: emptyToNull(input.reasonCode),
          reasonText: input.reasonText ?? null,
          origin: input.origin,
          source: has(original.sourceType) ? { type: original.sourceType, id: original.sourceId ?? '' } : null,
          reversalOf: original.id,
          postedBy: 'engine',
        },
        perms,
      );
      await tx.insert(registerReversals).values({ originalId: original.id, reversalId: posted.registerId });
      return posted;
    });
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const code = e.code ?? e.cause?.code;
  const name = e.constraint_name ?? e.cause?.constraint_name;
  return code === '23505' && name === constraint;
}
