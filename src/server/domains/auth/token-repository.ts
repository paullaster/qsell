import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNull, lt, max, or, isNotNull } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { authTokens, type AuthTokenPurpose } from '@/server/db/drizzle/schema';

export type { AuthTokenPurpose };

/** Anything that can run queries: the pool itself or an open transaction. */
export type DbExecutor = Pick<DrizzleDb, 'select' | 'insert' | 'update' | 'delete'>;

/** 256 bits of entropy, URL-safe so it can travel in a query string untouched. */
const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuanceStats {
  /** Tokens issued for this user and purpose since the window start. */
  count: number;
  latestAt: Date | null;
}

/**
 * Persistence for single-use, emailed auth tokens.
 *
 * The plaintext token exists only in the return value of `issue` (and the email
 * built from it); lookups hash the presented value. Consumption is one
 * conditional UPDATE, so concurrent requests with the same token cannot both win.
 */
export class AuthTokenRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Issue a fresh token, revoking any still-usable token for the same purpose so
   * only the most recently mailed link works.
   */
  async issue(userId: string, purpose: AuthTokenPurpose, ttlMs: number): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await this.revokeOutstanding(userId, purpose, tx);
      await tx.insert(authTokens).values({
        userId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + ttlMs),
        createdAt: now,
      });
    });
    return token;
  }

  async issuanceSince(
    userId: string,
    purpose: AuthTokenPurpose,
    since: Date,
  ): Promise<IssuanceStats> {
    const rows = await this.db
      .select({ count: count(), latestAt: max(authTokens.createdAt) })
      .from(authTokens)
      .where(
        and(
          eq(authTokens.userId, userId),
          eq(authTokens.purpose, purpose),
          gt(authTokens.createdAt, since),
        ),
      );
    // An aggregate without GROUP BY always yields exactly one row.
    const row = rows.at(0);
    return { count: row?.count ?? 0, latestAt: row?.latestAt ?? null };
  }

  /**
   * Atomically mark the token used and return its owner, or null when the token
   * is unknown, already used, expired, or minted for a different purpose.
   */
  async consume(
    token: string,
    purpose: AuthTokenPurpose,
    executor: DbExecutor = this.db,
  ): Promise<string | null> {
    const now = new Date();
    const rows = await executor
      .update(authTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authTokens.tokenHash, hashToken(token)),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.consumedAt),
          gt(authTokens.expiresAt, now),
        ),
      )
      .returning({ userId: authTokens.userId });
    return rows.at(0)?.userId ?? null;
  }

  async revokeOutstanding(
    userId: string,
    purpose: AuthTokenPurpose,
    executor: DbExecutor = this.db,
  ): Promise<void> {
    await executor
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authTokens.userId, userId),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.consumedAt),
        ),
      );
  }

  /** Housekeeping: drop tokens that can no longer be used and are past the audit window. */
  async purgeUnusable(before: Date): Promise<number> {
    const rows = await this.db
      .delete(authTokens)
      .where(
        and(
          lt(authTokens.createdAt, before),
          or(lt(authTokens.expiresAt, new Date()), isNotNull(authTokens.consumedAt)),
        ),
      )
      .returning({ id: authTokens.id });
    return rows.length;
  }
}
