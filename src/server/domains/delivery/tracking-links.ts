import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { orderTrackingLinks, orders } from '@/server/db/drizzle/schema';
import { isWellFormedTrackingToken } from '@/lib/tracking-token';
import { decryptCredentials, encryptCredentials, fingerprintSecret } from '@/server/domains/payments/crypto';
import type { EncryptedCredentialsBlob } from '@/server/domains/payments/types';
import type { DecisionLog } from '@/server/kernel/decision-log/service';

export interface ResolvedLink {
  companyId: string;
  orderId: string;
}

/**
 * The customer's link to follow their order. The token is random, kept sealed (so the link can be sent again in a message) and as a
 * keyed hash (so it is found without opening anything). One per order; it can be turned off, and a new one made, by someone who may
 * manage deliveries. A token that is not one of ours is turned away before the database is asked.
 */
export class TrackingLinks {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  private newToken(): string {
    return randomBytes(24).toString('base64url');
  }

  /** The order's token, made the first time it is asked for. Null if the link has been turned off. */
  async tokenFor(companyId: string, orderId: string): Promise<string | null> {
    const [existing] = await this.db.select().from(orderTrackingLinks).where(eq(orderTrackingLinks.orderId, orderId));
    if (existing !== undefined) return existing.revokedAt === null ? this.open(existing.tokenSealed) : null;
    const token = this.newToken();
    await this.db.insert(orderTrackingLinks).values({ companyId, orderId, tokenSealed: encryptCredentials({ token }), tokenHash: fingerprintSecret(token) }).onConflictDoNothing();
    // Two asking at once: one insert wins, and both read that one.
    const [row] = await this.db.select().from(orderTrackingLinks).where(eq(orderTrackingLinks.orderId, orderId));
    if (row === undefined) return null;
    return row.revokedAt === null ? this.open(row.tokenSealed) : null;
  }

  private open(sealed: EncryptedCredentialsBlob): string | null {
    const token = decryptCredentials(sealed)?.token;
    return typeof token === 'string' ? token : null;
  }

  /** How the order's link stands, for the people who run the shop: whether it is on, how often it was opened, and when last. */
  async describe(companyId: string, orderId: string): Promise<{ active: boolean; views: number; lastViewedAt: string | null }> {
    const [row] = await this.db.select().from(orderTrackingLinks).where(and(eq(orderTrackingLinks.orderId, orderId), eq(orderTrackingLinks.companyId, companyId)));
    return row === undefined ? { active: true, views: 0, lastViewedAt: null } : { active: row.revokedAt === null, views: row.views, lastViewedAt: row.lastViewedAt?.toISOString() ?? null };
  }

  /** Whose order a token is, or null: unknown, turned off, or past its date. A look is counted. */
  async resolve(token: unknown): Promise<ResolvedLink | null> {
    if (!isWellFormedTrackingToken(token)) return null;
    const [row] = await this.db.select().from(orderTrackingLinks).where(eq(orderTrackingLinks.tokenHash, fingerprintSecret(token)));
    if (row === undefined) return null;
    if (row.revokedAt !== null) return null;
    if ((row.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY) <= Date.now()) return null;
    await this.db.update(orderTrackingLinks).set({ views: sql`${orderTrackingLinks.views} + 1`, lastViewedAt: new Date() }).where(eq(orderTrackingLinks.id, row.id));
    return { companyId: row.companyId, orderId: row.orderId };
  }

  /** Turns the link off, or turns it off and makes a new one, with the reason in the decision log. Returns the new token, if one was made. */
  async replace(actor: { companyId: string; userId: string }, orderId: string, input: { reason?: unknown; renew: boolean }): Promise<{ ok: true; token: string | null } | { ok: false; message: string }> {
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : '';
    if (reason.length < 5) return { ok: false, message: 'Say why the link is being replaced, in a few words.' };
    return await this.db.transaction(async (tx) => {
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
      if (order === undefined) return { ok: false as const, message: 'That order could not be found.' };
      // A turned-off link keeps a token nobody holds, so an old link can never come back to life.
      const fresh = this.newToken();
      const values = { tokenSealed: encryptCredentials({ token: fresh }), tokenHash: fingerprintSecret(fresh), revokedAt: input.renew ? null : new Date(), views: 0, lastViewedAt: null };
      const [row] = await tx.select({ id: orderTrackingLinks.id }).from(orderTrackingLinks).where(and(eq(orderTrackingLinks.orderId, orderId), eq(orderTrackingLinks.companyId, actor.companyId))).for('update');
      if (row === undefined) await tx.insert(orderTrackingLinks).values({ companyId: actor.companyId, orderId, ...values });
      else await tx.update(orderTrackingLinks).set(values).where(eq(orderTrackingLinks.id, row.id));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'order', id: orderId }, action: input.renew ? 'tracking.link_renewed' : 'tracking.link_turned_off', actor: { type: 'user', id: actor.userId }, reason: { text: reason } }, tx);
      return { ok: true as const, token: input.renew ? fresh : null };
    });
  }
}
