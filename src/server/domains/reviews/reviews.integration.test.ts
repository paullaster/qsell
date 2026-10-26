import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { has, nth } from '@/lib/values';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as SchemaModule from '@/server/db/drizzle/schema';
import type { ReviewsService as Service, Reviewer } from './service';

/** Reviews against a real database: who may write one, what is shown, and that a product's rating always equals its approved reviews.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('product reviews (database)', () => {
  let db: typeof drizzleDb;
  let service: typeof Service;
  let schema: typeof SchemaModule;
  let itemTypeId: string;
  let branchId: string;
  const tag = randomUUID().slice(0, 6);

  const reviewer = (n: number, over: Partial<Reviewer> = {}): Reviewer => ({ key: `acct-${tag}-${String(n)}`, name: `Buyer ${String(n)} Person`, email: `buyer${String(n)}-${tag}@x.test`, ownerIds: [`acct-${tag}-${String(n)}`], ...over });

  const product = async (name: string) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `RV-${randomUUID().slice(0, 6)}`.toUpperCase(), stockCode: `RS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `${tag} ${name}`, slug: `rv-${randomUUID()}`, itemTypeId, price: '100', taxRate: '0', isTaxInclusive: true, stockQuantity: 10 });
    return id;
  };
  /** An order of this person's containing the product, in the given state. */
  const order = async (who: Reviewer, productId: string, status: string) => {
    const id = `rvo_${randomUUID()}`;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, status)
      VALUES (${id}, ${`RV-${randomUUID().slice(0, 8)}`}, ${who.key}, ${branchId}::uuid, 'Buyer', ${who.email}, '0700000000', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 100, 0, 0, 100, 'mpesa_daraja', ${status})`);
    await db.insert(schema.orderItems).values({ orderId: id, productId, productName: 'x', sku: 'x', quantity: 1, unitPrice: '100', totalPrice: '100' });
    return id;
  };
  const stored = async (productId: string) => {
    const row = nth(await db.select({ rating: schema.products.rating, count: schema.products.reviewCount }).from(schema.products).where(eq(schema.products.id, productId)), 0);
    return { rating: Number(row.rating), count: row.count };
  };
  const input = (rating: number, body = 'It works very well for us.') => ({ rating, title: 'Good', body });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    ({ ReviewsService: service } = await import('./service'));
    schema = await import('@/server/db/drizzle/schema');
    itemTypeId = `it_rv_${tag}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'RV', tradingName: 'RV', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    const [branch] = await db.insert(schema.branches).values({ companyId: nth([company], 0).id, code: `RV${tag}`, name: 'RV branch', isDefault: true }).returning();
    branchId = nth([branch], 0).id;
  });

  it('only someone who has received the product can review it, by the state of their order', async () => {
    const p = await product('Gated');
    const alice = reviewer(1);
    expect(await service.eligibility(null, p)).toEqual({ state: 'sign_in' });
    expect(await service.eligibility(alice, p)).toEqual({ state: 'not_purchased' });
    await expect(service.submit(alice, p, input(5))).rejects.toThrow(/after you have received/);

    await order(alice, p, 'processing');
    await order(alice, p, 'cancelled');
    expect(await service.eligibility(alice, p)).toEqual({ state: 'not_purchased' });

    await order(alice, p, 'delivered');
    expect(await service.eligibility(alice, p)).toEqual({ state: 'can_review' });
    // Someone else's delivered order does not count for her.
    const bob = reviewer(2);
    expect(await service.eligibility(bob, p)).toEqual({ state: 'not_purchased' });
  });

  it('finds the order by the email it was placed with when it carries no account id', async () => {
    const p = await product('By email');
    const carol = reviewer(3, { ownerIds: [] });
    await order({ ...carol, key: 'guest-order' }, p, 'completed');
    expect(await service.eligibility(carol, p)).toEqual({ state: 'can_review' });
  });

  it('a review waits for approval, is then shown, and the product rating follows each decision', async () => {
    const p = await product('Rated');
    const people = [reviewer(10), reviewer(11), reviewer(12)];
    for (const person of people) await order(person, p, 'delivered');
    await service.submit(nth(people, 0), p, input(5));
    await service.submit(nth(people, 1), p, input(4));
    await service.submit(nth(people, 2), p, input(1));

    // Nothing is shown, and the product still has no rating, until someone approves.
    expect((await service.page(p, null)).reviews).toEqual([]);
    expect(await stored(p)).toEqual({ rating: 0, count: 0 });
    expect(await service.eligibility(nth(people, 0), p)).toMatchObject({ state: 'reviewed', status: 'pending' });

    const queue = await service.queue({ status: 'pending', query: tag, cursor: null });
    const mine = queue.rows.filter((row) => row.productId === p);
    expect(mine).toHaveLength(3);
    expect(mine.every((row) => row.verifiedPurchase)).toBe(true);

    await service.moderate({ id: nth(mine, 0).id, decision: 'approve', note: '', actor: 'staff-1' });
    await service.moderate({ id: nth(mine, 1).id, decision: 'approve', note: '', actor: 'staff-1' });
    expect(await stored(p)).toEqual({ rating: 4.5, count: 2 });
    // A turned-down review needs a reason and is not counted.
    await expect(service.moderate({ id: nth(mine, 2).id, decision: 'reject', note: ' ', actor: 'staff-1' })).rejects.toThrow(/Say why/);
    await service.moderate({ id: nth(mine, 2).id, decision: 'reject', note: 'Not about the product.', actor: 'staff-1' });
    expect(await stored(p)).toEqual({ rating: 4.5, count: 2 });
    expect(await service.summary(p)).toMatchObject({ average: 4.5, count: 2 });
    expect(await service.eligibility(nth(people, 2), p)).toEqual({ state: 'reviewed', status: 'rejected', note: 'Not about the product.' });

    const shown = await service.page(p, null);
    expect(shown.reviews.map((r) => r.rating).sort()).toEqual([4, 5]);
    expect(shown.reviews[0]).toMatchObject({ verifiedPurchase: true });
    expect(shown.reviews[0]?.reviewerName).toMatch(/^Buyer P\.$/);
    expect(JSON.stringify(shown)).not.toContain('@');

    // Deleting an approved one brings the rating back down.
    await service.moderate({ id: nth(mine, 0).id, decision: 'delete', note: '', actor: 'staff-1' });
    expect(await stored(p)).toEqual({ rating: 4, count: 1 });
  });

  it('a second review replaces the first and goes back to waiting, taking the rating with it', async () => {
    const p = await product('Rewritten');
    const dan = reviewer(20);
    await order(dan, p, 'delivered');
    await service.submit(dan, p, input(5));
    const first = nth((await service.queue({ status: 'pending', query: tag, cursor: null })).rows.filter((row) => row.productId === p), 0);
    await service.moderate({ id: first.id, decision: 'approve', note: '', actor: 's' });
    expect(await stored(p)).toEqual({ rating: 5, count: 1 });

    await service.submit(dan, p, input(2, 'Changed my mind after a month.'));
    expect(await stored(p)).toEqual({ rating: 0, count: 0 });
    expect((await service.page(p, null)).reviews).toEqual([]);
    const rows = await db.select().from(schema.productReviews).where(eq(schema.productReviews.productId, p));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rating: 2, status: 'pending', moderationNote: '' });
  });

  it('pages approved reviews by key with no repeats, newest first', async () => {
    const p = await product('Many');
    for (let i = 0; i < 25; i += 1) {
      const who = reviewer(100 + i);
      await order(who, p, 'delivered');
      await service.submit(who, p, input((i % 5) + 1, `Review number ${String(i)} of many.`));
    }
    const waiting = (await service.queue({ status: 'pending', query: `Review number`, cursor: null })).rows;
    expect(waiting.length).toBeGreaterThan(0);
    await db.execute(sql`update product_reviews set status = 'approved' where product_id = ${p}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof service.page>> = await service.page(p, cursor);
      seen.push(...page.reviews.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it('refuses to review a product that is not for sale, and a decision on a review that is gone', async () => {
    const p = await product('Hidden');
    const erin = reviewer(30);
    await order(erin, p, 'delivered');
    await db.update(schema.products).set({ isActive: false }).where(eq(schema.products.id, p));
    await expect(service.submit(erin, p, input(3))).rejects.toThrow(/not available/);
    await expect(service.moderate({ id: randomUUID(), decision: 'approve', note: '', actor: 's' })).rejects.toThrow(/no longer exists/);
  });

  it('the database itself refuses a rating outside 1 to 5 and a too-short review', async () => {
    const p = await product('Constraints');
    const base = { productId: p, reviewerKey: `c-${randomUUID()}`, reviewerName: 'C', title: '', body: 'A long enough body here.' };
    await expect(db.insert(schema.productReviews).values({ ...base, rating: 6 })).rejects.toThrow();
    await expect(db.insert(schema.productReviews).values({ ...base, rating: 3, body: 'short' })).rejects.toThrow();
    await expect(db.insert(schema.productReviews).values({ ...base, rating: 3 })).resolves.toBeDefined();
    await expect(db.insert(schema.productReviews).values({ ...base, rating: 4 })).rejects.toThrow(); // one per person per product
  });
});
