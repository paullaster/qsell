import { and, count, desc, eq, ilike, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { drizzleDb, type DrizzleDb } from '@/server/db/drizzle/client';
import { newsletterSubscribers } from '@/server/db/drizzle/schema';
import { decodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { pageOf } from '@/server/domains/settings/paging';

export type SubscriberStatus = 'pending' | 'subscribed' | 'unsubscribed';
const PAGE = 50;

const newToken = (): string => randomBytes(32).toString('base64url');
const stamp = sql<string>`to_char(${newsletterSubscribers.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The shop's mailing list. Double opt-in: asking for the news only creates a `pending` row and sends a link, and nothing
 * is sent to the address until that link is followed. Whoever asks, the answer is the same, so the form cannot be used to
 * find out who is on the list.
 */
export const NewsletterService = {
  /** Starts (or restarts) a subscription. Returns the token to put in the confirmation link, or null when nothing needs sending. */
  async request(email: string, db: DrizzleDb = drizzleDb): Promise<string | null> {
    const [row] = await db.select({ status: newsletterSubscribers.status }).from(newsletterSubscribers).where(eq(newsletterSubscribers.email, email));
    if (row?.status === 'subscribed') return null;
    const token = newToken();
    await db
      .insert(newsletterSubscribers)
      .values({ email, token, status: 'pending' })
      .onConflictDoUpdate({ target: newsletterSubscribers.email, set: { token, status: 'pending', unsubscribedAt: null } });
    return token;
  },

  /** The person followed the confirmation link. Idempotent: following it twice changes nothing. */
  async confirm(token: string, db: DrizzleDb = drizzleDb): Promise<boolean> {
    const rows = await db
      .update(newsletterSubscribers)
      .set({ status: 'subscribed', confirmedAt: sql`coalesce(${newsletterSubscribers.confirmedAt}, now())`, unsubscribedAt: null })
      .where(and(eq(newsletterSubscribers.token, token), sql`${newsletterSubscribers.status} in ('pending', 'subscribed')`))
      .returning({ id: newsletterSubscribers.id });
    return rows.length > 0;
  },

  async unsubscribe(token: string, db: DrizzleDb = drizzleDb): Promise<boolean> {
    const rows = await db
      .update(newsletterSubscribers)
      .set({ status: 'unsubscribed', unsubscribedAt: sql`coalesce(${newsletterSubscribers.unsubscribedAt}, now())` })
      .where(eq(newsletterSubscribers.token, token))
      .returning({ id: newsletterSubscribers.id });
    return rows.length > 0;
  },

  /** The token that lets a subscriber opt out, for the link in each message. */
  async tokenFor(email: string, db: DrizzleDb = drizzleDb): Promise<string | null> {
    const [row] = await db.select({ token: newsletterSubscribers.token }).from(newsletterSubscribers).where(and(eq(newsletterSubscribers.email, email), eq(newsletterSubscribers.status, 'subscribed')));
    return row?.token ?? null;
  },

  /** For the people who run the list: a page, newest first, by status and words, with how many there are of each kind. */
  async page(input: { status: SubscriberStatus; query: string; cursor: string | null }, db: DrizzleDb = drizzleDb) {
    const after = input.cursor === null ? null : decodeCursor(input.cursor);
    const words = input.query.trim().slice(0, 100);
    const rows = await db
      .select({ id: newsletterSubscribers.id, email: newsletterSubscribers.email, status: newsletterSubscribers.status, createdAt: newsletterSubscribers.createdAt, confirmedAt: newsletterSubscribers.confirmedAt, sortKey: stamp.as('sort_key') })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.status, input.status),
          words === '' ? undefined : ilike(newsletterSubscribers.email, `%${escapeLike(words)}%`),
          after === null ? undefined : sql`(${newsletterSubscribers.createdAt}, ${newsletterSubscribers.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(newsletterSubscribers.createdAt), desc(newsletterSubscribers.id))
      .limit(PAGE + 1);
    const page = pageOf(rows, PAGE, (row) => ({ k: row.sortKey, id: row.id }));
    const totals = await db.select({ status: newsletterSubscribers.status, n: count() }).from(newsletterSubscribers).groupBy(newsletterSubscribers.status);
    return {
      rows: page.rows.map(({ sortKey: _sortKey, createdAt, confirmedAt, ...row }) => ({ ...row, createdAt: createdAt.toISOString(), confirmedAt: confirmedAt?.toISOString() ?? null })),
      nextCursor: page.nextCursor,
      totals: { pending: totals.find((t) => t.status === 'pending')?.n ?? 0, subscribed: totals.find((t) => t.status === 'subscribed')?.n ?? 0, unsubscribed: totals.find((t) => t.status === 'unsubscribed')?.n ?? 0 },
    };
  },

  /** Every confirmed address, oldest first, for sending from the company's own mail tool. */
  async confirmedEmails(db: DrizzleDb = drizzleDb): Promise<{ email: string; confirmedAt: Date | null }[]> {
    return await db.select({ email: newsletterSubscribers.email, confirmedAt: newsletterSubscribers.confirmedAt }).from(newsletterSubscribers).where(eq(newsletterSubscribers.status, 'subscribed')).orderBy(newsletterSubscribers.createdAt);
  },
};
