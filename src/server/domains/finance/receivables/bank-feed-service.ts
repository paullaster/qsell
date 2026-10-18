import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { bankAccounts, bankFeeds, type BankFeedRow } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { feedSecretHash, feedSecretMatches, newFeedSecret, parseFeedPayload } from '../domain/bank-feed';
import { FinanceError, type FinanceContext } from '../errors';
import type { BankStatementService } from './bank-statement-service';

export interface FeedResult {
  lines: number;
  duplicates: number;
  autoMatched: number;
  proposed: number;
}

export type FeedOutcome = { ok: true; result: FeedResult } | { ok: false; status: 404 | 400 | 409; error: string };

/**
 * A bank that pushes its statement lines to us. The feed belongs to one bank account and has its own address, whose secret is
 * shown once and kept only as a fingerprint. What arrives goes through the same checks, de-duplication and matching as a file
 * a person imports; a delivery sent twice is recognised and changes nothing.
 */
export class BankFeedService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly statements: BankStatementService,
  ) {}

  async status(companyId: string, bankAccountId: string) {
    const [f] = await this.db.select().from(bankFeeds).where(and(eq(bankFeeds.companyId, companyId), eq(bankFeeds.bankAccountId, bankAccountId)));
    return f === undefined ? null : { id: f.id, enabled: f.enabled, hint: f.secretHint, createdAt: f.createdAt, rotatedAt: f.rotatedAt, lastReceivedAt: f.lastReceivedAt, lastLines: f.lastLines, receivedCount: f.receivedCount, lastError: f.lastError };
  }

  /** Makes the feed (or gives it a new secret, which stops the old address working). The secret is returned this once. */
  async enable(ctx: FinanceContext, bankAccountId: string): Promise<{ id: string; secret: string }> {
    const [account] = await this.db.select().from(bankAccounts).where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, bankAccountId)));
    if (!account) throw new FinanceError('ACCOUNT_NOT_FOUND', 'That bank account does not exist.');
    if (account.kind === 'clearing') throw new FinanceError('ACCOUNT_KIND', `${account.code} is a clearing account: it has no statement of its own.`);
    if (account.blocked) throw new FinanceError('BANK_BLOCKED', `${account.code} is blocked.`);
    const secret = newFeedSecret();
    const values = { secretHash: feedSecretHash(secret), secretHint: secret.slice(-4), enabled: true };
    return await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(bankFeeds).where(eq(bankFeeds.bankAccountId, bankAccountId)).for('update');
      let id: string;
      if (existing) {
        id = existing.id;
        await tx.update(bankFeeds).set({ ...values, rotatedAt: new Date(), lastError: null }).where(eq(bankFeeds.id, id));
      } else {
        [{ id }] = await tx.insert(bankFeeds).values({ companyId: ctx.companyId, bankAccountId, createdBy: ctx.actor.id ?? 'system', ...values }).returning({ id: bankFeeds.id });
      }
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_feed', id }, action: existing ? 'finance.bank_feed_rotated' : 'finance.bank_feed_created', actor: ctx.actor, inputs: { origin: ctx.origin, account: account.code }, outcome: { hint: values.secretHint } }, tx);
      return { id, secret };
    });
  }

  async disable(ctx: FinanceContext, bankAccountId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [f] = await tx.select().from(bankFeeds).where(and(eq(bankFeeds.companyId, ctx.companyId), eq(bankFeeds.bankAccountId, bankAccountId))).for('update');
      if (!f) throw new FinanceError('NO_FEED', 'This account has no feed.');
      await tx.update(bankFeeds).set({ enabled: false }).where(eq(bankFeeds.id, f.id));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_feed', id: f.id }, action: 'finance.bank_feed_disabled', actor: ctx.actor, inputs: { origin: ctx.origin } }, tx);
    });
  }

  /** Looks the feed up by its account and checks the secret. A wrong or unknown secret, and a disabled feed, are all just "not found". */
  private async authenticate(bankAccountId: string, secret: string): Promise<BankFeedRow | null> {
    const [f] = await this.db.select().from(bankFeeds).where(eq(bankFeeds.bankAccountId, bankAccountId));
    // The comparison is made even when there is no feed, so the answer takes the same time either way.
    const matches = feedSecretMatches(secret, f?.secretHash ?? '0'.repeat(64));
    return f !== undefined && matches && f.enabled ? f : null;
  }

  async ingest(bankAccountId: string, secret: string, body: unknown, meta: { ip: string | null }): Promise<FeedOutcome> {
    if (!/^[0-9a-f-]{36}$/i.test(bankAccountId)) return { ok: false, status: 404, error: 'Not found.' };
    const feed = await this.authenticate(bankAccountId, secret);
    if (feed === null) return { ok: false, status: 404, error: 'Not found.' };
    const parsed = parseFeedPayload(body);
    if ('error' in parsed) {
      await this.db.update(bankFeeds).set({ lastError: parsed.error.slice(0, 500) }).where(eq(bankFeeds.id, feed.id));
      return { ok: false, status: 400, error: parsed.error };
    }
    const [account] = await this.db.select().from(bankAccounts).where(eq(bankAccounts.id, feed.bankAccountId));
    const ctx: FinanceContext = { companyId: feed.companyId, actor: { type: 'integration', id: `bank-feed:${feed.id}` }, origin: { surface: 'bank-feed', action: 'ingest', ip: meta.ip } };
    try {
      const done = await this.statements.importParsed(ctx, account, parsed.statement, { fileName: `feed ${new Date().toISOString().slice(0, 16)}`, fileHash: parsed.fingerprint, format: 'feed' });
      await this.db.update(bankFeeds).set({ lastReceivedAt: new Date(), lastLines: done.lines, lastError: null, receivedCount: sql`${bankFeeds.receivedCount} + 1` }).where(eq(bankFeeds.id, feed.id));
      return { ok: true, result: { lines: done.lines, duplicates: done.duplicates, autoMatched: done.autoMatched, proposed: done.proposed } };
    } catch (error) {
      const code = error instanceof FinanceError ? error.code : '';
      const message = error instanceof FinanceError ? error.message : 'The lines could not be kept.';
      // The same delivery sent again, or lines the bank already sent: not a problem, and nothing changes.
      if (code === 'NOTHING_NEW' || code === 'ALREADY_IMPORTED') {
        await this.db.update(bankFeeds).set({ lastReceivedAt: new Date(), lastLines: 0, lastError: null, receivedCount: sql`${bankFeeds.receivedCount} + 1` }).where(eq(bankFeeds.id, feed.id));
        return { ok: true, result: { lines: 0, duplicates: parsed.statement.lines.length, autoMatched: 0, proposed: 0 } };
      }
      await this.db.update(bankFeeds).set({ lastError: message.slice(0, 500) }).where(eq(bankFeeds.id, feed.id));
      if (!(error instanceof FinanceError)) console.error('[bank-feed]', error);
      return { ok: false, status: error instanceof FinanceError ? 400 : 409, error: message };
    }
  }
}
