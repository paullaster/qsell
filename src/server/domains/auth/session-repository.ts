import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { userSessions, type UserSessionInsert, type UserSessionRow } from '@/server/db/drizzle/schema';
import type { UserSession } from '@/types/index';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toSession(row: UserSessionRow): UserSession {
  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role as UserSession['role'],
    token: '',
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Server-side session storage for the legacy `AuthService` login path.
 *
 * Session tokens are bearer secrets, so only a SHA-256 hash is persisted. The
 * plaintext token is returned to the caller from `create` and looked up by hash
 * on every read, which means a database leak cannot be replayed as a session.
 */
export class UserSessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(
    input: Omit<UserSession, 'token' | 'createdAt'>,
    token: string,
  ): Promise<UserSession> {
    const values: UserSessionInsert = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      userId: input.userId,
      email: input.email,
      name: input.name,
      role: input.role,
    };
    const [row] = await this.db.insert(userSessions).values(values).returning();
    return { ...input, token, createdAt: row!.createdAt.toISOString() };
  }

  async findByToken(token: string): Promise<UserSession | null> {
    const rows = await this.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, hashToken(token)))
      .limit(1);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async deleteByToken(token: string): Promise<boolean> {
    const rows = await this.db
      .delete(userSessions)
      .where(eq(userSessions.tokenHash, hashToken(token)))
      .returning();
    return rows.length > 0;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const rows = await this.db
      .delete(userSessions)
      .where(eq(userSessions.userId, userId))
      .returning();
    return rows.length;
  }

  /** Housekeeping: drop sessions older than the cutoff. */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(userSessions)
      .where(sql`${userSessions.createdAt} < ${cutoff}`)
      .returning();
    return rows.length;
  }
}
