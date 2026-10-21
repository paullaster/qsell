import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, required } from '@/lib/values';
import { NO_LIMITS, type RefundLimitValues } from './domain/refund-limits';
import { refundKit } from './refund-test-kit';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
describe.skipIf(!has(process.env.TEST_DATABASE_URL))('refund limits (database)', () => {
  const k = refundKit('RLM');
  let version = 0;
  const save = async (over: Partial<RefundLimitValues>) => {
    const out = await k.fin.refundLimits.save(
      k.ctx,
      { ...NO_LIMITS, enabled: true, ...over },
      version,
    );
    version = out.version;
    return out;
  };
  const row = async (id: string) =>
    required(
      (
        await k.db.select().from(k.schema.refundRequests).where(eq(k.schema.refundRequests.id, id))
      )[0],
    );

  beforeEach(async () => {
    // Each test starts from no limits and no refunds standing in the window.
    version = (await k.fin.refundLimits.view(k.companyId)).version;
    await save({ enabled: false });
    await k.db
      .update(k.schema.refundRequests)
      .set({ status: 'cancelled' })
      .where(eq(k.schema.refundRequests.companyId, k.companyId));
  });

  it('starts with nothing limited, and saves as one version at a time', async () => {
    expect((await k.fin.refundLimits.view(randomUUID())).values).toEqual(NO_LIMITS);
    const saved = await save({ maxPerCustomer: 2 });
    expect(saved.values).toMatchObject({ enabled: true, maxPerCustomer: 2, mode: 'review' });
    expect(saved.updatedBy).toBe('tester');
    // Someone else saved in between: the older screen is refused instead of overwriting.
    expect(
      await k.codeOf(
        k.fin.refundLimits.save(
          k.ctx,
          { ...NO_LIMITS, enabled: true, maxPerCustomer: 9 },
          version - 1,
        ),
      ),
    ).toBe('CHANGED_SINCE');
    expect((await k.fin.refundLimits.view(k.companyId)).values.maxPerCustomer).toBe(2);
  });

  it('holds the refund past a per-customer count for approval, whatever its amount, and says why', async () => {
    await k.policy();
    await save({ maxPerCustomer: 2 });
    const o = await k.owed(3);
    const first = await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '100.00');
    const second = await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '110.00');
    expect((await row(first.id)).heldForReview).toBeNull();
    expect((await row(second.id)).heldForReview).toBeNull();
    const third = await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '120.00');
    expect((await row(third.id)).heldForReview).toBe(
      'This customer would have 3 refunds in a day; the limit is 2.',
    );
    // With no workflow to approve it, it cannot go through on its own.
    expect(await k.codeOf(k.fin.refunds.submit(k.ctx, third.id))).toBe('HELD_NEEDS_APPROVAL');
    expect((await k.fin.refunds.submit(k.ctx, first.id)).status).toBe('approved');
  });

  it('refuses it instead when the limits say so', async () => {
    await k.policy();
    await save({ maxPerCustomer: 1, mode: 'refuse' });
    const o = await k.owed(2);
    await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '100.00');
    expect(await k.codeOf(k.request(o.customer.id, 'credit_note_excess', o.cn.id, '130.00'))).toBe(
      'VELOCITY_LIMIT',
    );
  });

  it('limits the money one customer is refunded in the window', async () => {
    await k.policy();
    await save({ maxCentsPerCustomer: 30_000, mode: 'refuse' });
    const o = await k.owed(2);
    await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '200.00');
    expect(await k.codeOf(k.request(o.customer.id, 'credit_note_excess', o.cn.id, '101.00'))).toBe(
      'VELOCITY_LIMIT',
    );
    expect(
      (await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '100.00')).id,
    ).toBeTruthy();
  });

  it('limits how often one phone number is paid, across different customers and however it is typed', async () => {
    await k.policy();
    await save({ maxPerDestination: 1, mode: 'refuse' });
    const a = await k.owed();
    const b = await k.owed();
    const pay = (o: typeof a, phone: string) =>
      k.request(o.customer.id, 'credit_note_excess', o.cn.id, '100.00', {
        paymentMethodId: k.methodId.MPESA,
        payoutDetails: { phone },
        mayChangeDestination: true,
      });
    await pay(a, '0799 000 111');
    expect(await k.codeOf(pay(b, '+254799000111'))).toBe('VELOCITY_LIMIT');
    // A different phone is fine.
    expect((await pay(b, '0799000222')).id).toBeTruthy();
  });

  it('limits how much one person asks for', async () => {
    await k.policy();
    await save({ maxPerRequester: 1, mode: 'refuse' });
    const a = await k.owed();
    const b = await k.owed();
    await k.request(a.customer.id, 'credit_note_excess', a.cn.id, '100.00');
    expect(await k.codeOf(k.request(b.customer.id, 'credit_note_excess', b.cn.id, '100.00'))).toBe(
      'VELOCITY_LIMIT',
    );
    // Another person asking is counted on their own.
    const other = await k.fin.refunds.create(
      { ...k.ctx, actor: { type: 'user', id: k.requester } },
      {
        customerId: b.customer.id,
        sourceKind: 'credit_note_excess',
        sourceId: b.cn.id,
        amount: '100.00',
        paymentMethodId: k.methodId.CASH,
        payoutDetails: { recipientName: 'Customer' },
        reasonCode: 'CUSTOMER_REQUEST',
        mayChangeDestination: false,
      },
    );
    expect(other.id).toBeTruthy();
  });

  it('does not count refunds that were cancelled, turned down or are older than the window', async () => {
    await k.policy();
    await save({ maxPerCustomer: 1, mode: 'refuse', windowHours: 1 });
    const o = await k.owed(2);
    const old = await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '100.00');
    // Made two hours ago: outside a one-hour window.
    await k.db
      .update(k.schema.refundRequests)
      .set({ createdAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(k.schema.refundRequests.id, old.id));
    const now = await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '110.00');
    expect(await k.codeOf(k.request(o.customer.id, 'credit_note_excess', o.cn.id, '120.00'))).toBe(
      'VELOCITY_LIMIT',
    );
    // Cancelling the one inside the window makes room.
    await k.fin.refunds.cancel(k.ctx, now.id, { code: 'CUSTOMER_REQUEST' }, {} as never);
    expect(
      (await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '120.00')).id,
    ).toBeTruthy();
  });

  it('is off until switched on, and off again when it is', async () => {
    await k.policy();
    await save({ maxPerCustomer: 1, mode: 'refuse', enabled: false });
    const o = await k.owed(3);
    await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '100.00');
    expect(
      (await k.request(o.customer.id, 'credit_note_excess', o.cn.id, '110.00')).id,
    ).toBeTruthy();
  });
});
