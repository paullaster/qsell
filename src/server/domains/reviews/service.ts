import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { drizzleDb, type DrizzleDb } from '@/server/db/drizzle/client';
import { orderItems, orders, productReviews, products } from '@/server/db/drizzle/schema';
import { decodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { pageOf } from '@/server/domains/settings/paging';
import { SettingsError } from '@/server/domains/settings/errors';
import { ratingSummary, reviewerDisplayName, type PublicReview, type RatingSummary, type ReviewEligibility, type ReviewInput } from '@/lib/reviews';

/** Who is writing: the signed-in shopper, from the session. */
export interface Reviewer {
  key: string;
  name: string;
  /** Every id an order of theirs may carry (account id, store customer id) and their email, to find those orders. */
  ownerIds: string[];
  email: string;
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected';
/** What a query needs: the database itself or a transaction on it. */
type Queryable = Pick<DrizzleDb, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
const REVIEW_PAGE = 10;
const QUEUE_PAGE = 25;

const stamp = (column: SQL | typeof productReviews.createdAt) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Keeps the product's average and count equal to its approved reviews. Always called in the transaction that changed one. */
async function recalculate(tx: Queryable, productId: string): Promise<void> {
  await tx.execute(sql`
    update products set
      rating = coalesce((select round(avg(rating)::numeric, 2) from product_reviews where product_id = ${productId} and status = 'approved'), 0),
      review_count = (select count(*)::int from product_reviews where product_id = ${productId} and status = 'approved'),
      updated_at = now()
    where id = ${productId}`);
}

/** The delivered or completed order that lets this person review this product, if there is one. */
async function qualifyingOrder(db: Queryable, reviewer: Reviewer, productId: string): Promise<string | null> {
  const mine = [inArray(orders.userId, reviewer.ownerIds.length === 0 ? ['-'] : reviewer.ownerIds)];
  if (reviewer.email !== '') mine.push(sql`lower(btrim(${orders.customerEmail})) = ${reviewer.email}`);
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(and(eq(orderItems.productId, productId), inArray(orders.status, ['delivered', 'completed']), or(...mine)))
    .limit(1);
  return row?.id ?? null;
}

/** Rows after the cursor: later ones for the waiting queue (oldest first), earlier ones for the decided lists (newest first). */
const queueAfter = (waiting: boolean, after: { k: string; id: string }): SQL =>
  waiting
    ? sql`(${productReviews.createdAt}, ${productReviews.id}) > (${after.k}::timestamptz, ${after.id}::uuid)`
    : sql`(${productReviews.createdAt}, ${productReviews.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`;

export const ReviewsService = {
  /** Average, count and spread of the approved reviews of a product. */
  async summary(productId: string, db: DrizzleDb = drizzleDb): Promise<RatingSummary> {
    const rows = await db
      .select({ rating: productReviews.rating, count: count() })
      .from(productReviews)
      .where(and(eq(productReviews.productId, productId), eq(productReviews.status, 'approved')))
      .groupBy(productReviews.rating);
    return ratingSummary(rows);
  },

  /** One page of approved reviews, newest first, by key (so nothing repeats when a review is added between pages). */
  async page(productId: string, cursor: string | null, db: DrizzleDb = drizzleDb): Promise<{ reviews: PublicReview[]; nextCursor: string | null }> {
    const after = cursor === null ? null : decodeCursor(cursor);
    const rows = await db
      .select({
        id: productReviews.id,
        rating: productReviews.rating,
        title: productReviews.title,
        body: productReviews.body,
        reviewerName: productReviews.reviewerName,
        verifiedPurchase: productReviews.verifiedPurchase,
        createdAt: productReviews.createdAt,
        sortKey: stamp(productReviews.createdAt).as('sort_key'),
      })
      .from(productReviews)
      .where(
        and(
          eq(productReviews.productId, productId),
          eq(productReviews.status, 'approved'),
          after === null ? undefined : sql`(${productReviews.createdAt}, ${productReviews.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
      .limit(REVIEW_PAGE + 1);
    const page = pageOf(rows, REVIEW_PAGE, (row) => ({ k: row.sortKey, id: row.id }));
    return {
      reviews: page.rows.map((row) => ({ id: row.id, rating: row.rating, title: row.title, body: row.body, reviewerName: row.reviewerName, verifiedPurchase: row.verifiedPurchase, createdAt: row.createdAt.toISOString() })),
      nextCursor: page.nextCursor,
    };
  },

  /** What this person may do about reviewing this product. `reviewer` is null for someone who is not signed in. */
  async eligibility(reviewer: Reviewer | null, productId: string, db: DrizzleDb = drizzleDb): Promise<ReviewEligibility> {
    if (reviewer === null) return { state: 'sign_in' };
    const [own] = await db
      .select({ status: productReviews.status, note: productReviews.moderationNote })
      .from(productReviews)
      .where(and(eq(productReviews.productId, productId), eq(productReviews.reviewerKey, reviewer.key)))
      .limit(1);
    if (own !== undefined) return { state: 'reviewed', status: own.status, note: own.note };
    return (await qualifyingOrder(db, reviewer, productId)) === null ? { state: 'not_purchased' } : { state: 'can_review' };
  },

  /**
   * Saves the person's review. Only someone with a delivered or completed order for the product may write one, and a
   * second review from the same person replaces the first and goes back to waiting for approval.
   */
  async submit(reviewer: Reviewer, productId: string, input: ReviewInput, db: DrizzleDb = drizzleDb): Promise<void> {
    await db.transaction(async (tx) => {
      const [product] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, productId), eq(products.isActive, true), eq(products.isSellable, true)));
      if (product === undefined) throw new SettingsError('This product is not available.');
      const orderId = await qualifyingOrder(tx, reviewer, productId);
      if (orderId === null) throw new SettingsError('You can review a product after you have received it.');
      const values = {
        productId,
        reviewerKey: reviewer.key,
        reviewerName: reviewerDisplayName(reviewer.name),
        rating: input.rating,
        title: input.title,
        body: input.body,
        status: 'pending' as const,
        verifiedPurchase: true,
        orderId,
        moderationNote: '',
        moderatedBy: null,
        moderatedAt: null,
      };
      await tx
        .insert(productReviews)
        .values(values)
        .onConflictDoUpdate({ target: [productReviews.productId, productReviews.reviewerKey], set: { ...values, updatedAt: new Date() } });
      await recalculate(tx, productId);
    });
  },

  /** The moderation queue: reviews waiting (oldest first) or already decided (newest first), searchable by product, person or words. */
  async queue(input: { status: ReviewStatus; query: string; cursor: string | null }, db: DrizzleDb = drizzleDb) {
    const after = input.cursor === null ? null : decodeCursor(input.cursor);
    const waiting = input.status === 'pending';
    const words = input.query.trim().slice(0, 100);
    const pattern = `%${escapeLike(words)}%`;
    const rows = await db
      .select({
        id: productReviews.id,
        productId: productReviews.productId,
        productName: products.name,
        productSlug: products.slug,
        rating: productReviews.rating,
        title: productReviews.title,
        body: productReviews.body,
        reviewerName: productReviews.reviewerName,
        verifiedPurchase: productReviews.verifiedPurchase,
        status: productReviews.status,
        moderationNote: productReviews.moderationNote,
        createdAt: productReviews.createdAt,
        sortKey: stamp(productReviews.createdAt).as('sort_key'),
      })
      .from(productReviews)
      .innerJoin(products, eq(products.id, productReviews.productId))
      .where(
        and(
          eq(productReviews.status, input.status),
          words === '' ? undefined : or(ilike(products.name, pattern), ilike(productReviews.reviewerName, pattern), ilike(productReviews.body, pattern), ilike(productReviews.title, pattern)),
          after === null ? undefined : queueAfter(waiting, after),
        ),
      )
      .orderBy(...(waiting ? [asc(productReviews.createdAt), asc(productReviews.id)] : [desc(productReviews.createdAt), desc(productReviews.id)]))
      .limit(QUEUE_PAGE + 1);
    const page = pageOf(rows, QUEUE_PAGE, (row) => ({ k: row.sortKey, id: row.id }));
    const [waitingCount] = await db.select({ value: count() }).from(productReviews).where(eq(productReviews.status, 'pending'));
    return {
      rows: page.rows.map(({ sortKey: _sortKey, createdAt, ...row }) => ({ ...row, createdAt: createdAt.toISOString() })),
      nextCursor: page.nextCursor,
      waiting: waitingCount?.value ?? 0,
    };
  },

  /** Approves, rejects (with a reason the reviewer is shown) or deletes a review, and brings the product's rating up to date in the same step. */
  async moderate(input: { id: string; decision: 'approve' | 'reject' | 'delete'; note: string; actor: string }, db: DrizzleDb = drizzleDb): Promise<void> {
    await db.transaction(async (tx) => {
      const [review] = await tx.select({ productId: productReviews.productId }).from(productReviews).where(eq(productReviews.id, input.id)).for('update');
      if (review === undefined) throw new SettingsError('This review no longer exists.');
      if (input.decision === 'delete') {
        await tx.delete(productReviews).where(eq(productReviews.id, input.id));
      } else {
        const note = input.note.trim().slice(0, 300);
        if (input.decision === 'reject' && note === '') throw new SettingsError('Say why the review is being turned down: the reviewer will see it.');
        await tx
          .update(productReviews)
          .set({ status: input.decision === 'approve' ? 'approved' : 'rejected', moderationNote: input.decision === 'approve' ? '' : note, moderatedBy: input.actor, moderatedAt: new Date(), updatedAt: new Date() })
          .where(eq(productReviews.id, input.id));
      }
      await recalculate(tx, review.productId);
    });
  },
};
