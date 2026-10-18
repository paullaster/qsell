import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { has, required } from '@/lib/values';
import { refundKit } from './refund-test-kit';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
describe.skipIf(!has(process.env.TEST_DATABASE_URL))('gift cards and loyalty points in the books (database)', () => {
  const k = refundKit('ISSUE');
  const actor = { type: 'user' as const, id: 'tester' };
  const why = { code: 'DATA_ENTRY_ERROR' };
  let customer: { id: string };

  beforeAll(async () => {
    const [cust] = await k.db.insert(k.schema.customers).values({ companyId: k.companyId, number: `IS${randomUUID().slice(0, 6)}`, name: 'Points holder', accountType: 'cash', creditLimit: '0' }).returning();
    customer = cust;
    await k.c.loyalty.saveProgram(k.companyId, { name: 'Points', status: 'active', config: { pointsPer100: 5, pointValue: 2, minRedeemPoints: 10, maxRedeemPercent: 50, expiryMonths: null, tiers: [] } }, actor, why);
  });

  const earn = async (spend: number) => {
    const orderId = `ord_${randomUUID()}`;
    await k.db.transaction(async (tx) => await k.c.loyalty.earnOrder(tx, { companyId: k.companyId, customerId: customer.id, orderId, spend }));
    return orderId;
  };
  const linesOf = async (registerId: string) => {
    const no = new Map(Object.entries(k.acct).map(([n, id]) => [id, n]));
    return (await k.db.select().from(k.schema.glEntries).where(eq(k.schema.glEntries.registerId, registerId))).map((l) => [no.get(l.accountId), Number(l.debit), Number(l.credit)]).sort();
  };
  const queued = async (kind: string) => await k.db.select().from(k.schema.financeSalesPostings).where(and(eq(k.schema.financeSalesPostings.companyId, k.companyId), eq(k.schema.financeSalesPostings.kind, kind as never))).orderBy(k.schema.financeSalesPostings.createdAt);
  const issue = (value: number, funding?: { kind: 'sold'; paymentMethodId: string } | { kind: 'complimentary' }) => k.c.giftCards.issue(k.companyId, { value, funding }, actor, why);

  describe('before the books are live', () => {
    it('queues nothing, and what is owed on the day comes in as an opening balance', async () => {
      await issue(300);
      await earn(1000); // 50 points, worth 100
      expect(await queued('gift_card_issue')).toEqual([]);
      expect(await queued('loyalty_change')).toEqual([]);
      const out = await k.fin.salesPosting.goLive(k.ctx, { offsetAccountId: k.acct['3100'] });
      expect(out.opening.map((o) => o.group)).toEqual(expect.arrayContaining(['gift cards', 'loyalty points']));
      const recon = await k.fin.salesPosting.liabilityReconciliation(k.companyId);
      expect(recon.map((r) => [r.label, r.diffCents])).toEqual([['Gift cards', 0], ['Loyalty points', 0]]);
      expect(recon.find((r) => r.label === 'Gift cards')?.glCents).toBe(30000);
      expect(recon.find((r) => r.label === 'Loyalty points')?.glCents).toBe(10000);
    });
  });

  describe('once the books are live', () => {
    it('a card given free is a cost and a card sold is money in, both owed to the holder, and the code never reaches the books', async () => {
      await k.fin.salesPosting.processDue();
      expect(await k.codeOf(issue(100))).toBe('INVALID');
      expect(await k.codeOf(issue(100, { kind: 'sold', paymentMethodId: randomUUID() }))).toBe('NOT_FOUND');
      const [free] = await issue(100, { kind: 'complimentary' });
      const [sold] = await issue(250, { kind: 'sold', paymentMethodId: k.methodId.CASH });
      const out = await k.fin.salesPosting.processDue();
      expect(out.failed).toBe(0);
      const rows = await queued('gift_card_issue');
      expect(rows.filter((r) => r.status === 'posted')).toHaveLength(2);
      const byCard = new Map<string, string[][]>();
      for (const r of rows) {
        const [ledger] = await k.db.select().from(k.schema.giftCardLedger).where(eq(k.schema.giftCardLedger.id, r.subjectId));
        byCard.set(ledger.cardId, (await linesOf(required(r.registerId))) as never);
      }
      expect(byCard.get(free.id)).toEqual([['2230', 0, 100], ['6310', 100, 0]]);
      expect(byCard.get(sold.id)).toEqual([['1110', 250, 0], ['2230', 0, 250]]);
      const bank = await k.db.select().from(k.schema.bankLedgerEntries).where(and(eq(k.schema.bankLedgerEntries.companyId, k.companyId), eq(k.schema.bankLedgerEntries.documentType, 'gift_card_sale')));
      expect(bank.map((b) => Number(b.amount))).toEqual([250]);
      const text = JSON.stringify(await k.db.select().from(k.schema.glEntries).where(eq(k.schema.glEntries.companyId, k.companyId)));
      expect(text).not.toContain(free.code);
      expect(text).not.toContain(sold.code);
      expect((await k.fin.salesPosting.liabilityReconciliation(k.companyId)).find((r) => r.label === 'Gift cards')?.diffCents).toBe(0);
    });

    it('points given are a cost and a provision at their value; taken back, they are released', async () => {
      const orderId = await earn(2000); // 100 points, worth 200
      await k.fin.salesPosting.processDue();
      const given = (await queued('loyalty_change')).at(-1);
      expect(await linesOf(required(given?.registerId ?? null))).toEqual([['2240', 0, 200], ['6310', 200, 0]]);
      await k.db.transaction(async (tx) => await k.c.loyalty.reverseOrder(tx, orderId));
      await k.fin.salesPosting.processDue();
      const back = (await queued('loyalty_change')).at(-1);
      expect(await linesOf(required(back?.registerId ?? null))).toEqual([['2240', 200, 0], ['6310', 0, 200]]);
      expect((await k.fin.salesPosting.liabilityReconciliation(k.companyId)).find((r) => r.label === 'Loyalty points')?.diffCents).toBe(0);
    });

    it('points that lapse or are taken off by hand are released from what is owed', async () => {
      await earn(1000);
      await k.fin.salesPosting.processDue();
      await k.db.insert(k.schema.loyaltyLedger).values({ companyId: k.companyId, customerId: customer.id, kind: 'expire', points: -10, actor: 'system' });
      await k.db.update(k.schema.loyaltyAccounts).set({ balance: sql`${k.schema.loyaltyAccounts.balance} - 10` }).where(eq(k.schema.loyaltyAccounts.customerId, customer.id));
      await k.fin.salesPosting.processDue();
      const lapsed = (await queued('loyalty_change')).at(-1);
      expect(await linesOf(required(lapsed?.registerId ?? null))).toEqual([['2240', 20, 0], ['6310', 0, 20]]);
      expect((await k.fin.salesPosting.liabilityReconciliation(k.companyId)).find((r) => r.label === 'Loyalty points')?.diffCents).toBe(0);
    });

    it('value taken off a card by hand is released as income', async () => {
      const [card] = await issue(80, { kind: 'complimentary' });
      await k.fin.salesPosting.processDue();
      await k.db.update(k.schema.giftCards).set({ balance: '50.00' }).where(eq(k.schema.giftCards.id, card.id));
      await k.db.insert(k.schema.giftCardLedger).values({ cardId: card.id, kind: 'adjust', amount: '-30.00', actor: 'tester' });
      await k.fin.salesPosting.processDue();
      const rows = await queued('gift_card_adjust');
      expect(await linesOf(required(rows.at(-1)?.registerId ?? null))).toEqual([['2230', 30, 0], ['4430', 0, 30]]);
      expect((await k.fin.salesPosting.liabilityReconciliation(k.companyId)).find((r) => r.label === 'Gift cards')?.diffCents).toBe(0);
    });

    it('a card past its date is written off once, and the value owed becomes income', async () => {
      const [card] = await issue(60, { kind: 'complimentary' });
      const [fresh] = await issue(40, { kind: 'complimentary' });
      await k.fin.salesPosting.processDue();
      const now = new Date();
      await k.db.update(k.schema.giftCards).set({ expiresAt: new Date(now.getTime() - 86_400_000) }).where(eq(k.schema.giftCards.id, card.id));
      await k.db.update(k.schema.giftCards).set({ expiresAt: new Date(now.getTime() + 86_400_000) }).where(eq(k.schema.giftCards.id, fresh.id));
      const first = await k.c.giftCards.expireDue(now);
      expect(first.expired).toBeGreaterThanOrEqual(1);
      expect((await k.c.giftCards.expireDue(now)).expired).toBe(0);
      const [after] = await k.db.select().from(k.schema.giftCards).where(eq(k.schema.giftCards.id, card.id));
      const [kept] = await k.db.select().from(k.schema.giftCards).where(eq(k.schema.giftCards.id, fresh.id));
      expect([after.balance, kept.balance]).toEqual(['0.00', '40.00']);
      const ledger = await k.db.select().from(k.schema.giftCardLedger).where(and(eq(k.schema.giftCardLedger.cardId, card.id), eq(k.schema.giftCardLedger.kind, 'adjust')));
      expect(ledger.map((l) => [l.amount, l.reasonCode])).toEqual([['-60.00', 'GIFT_CARD_EXPIRED']]);
      await k.fin.salesPosting.processDue();
      const rows = await queued('gift_card_adjust');
      expect(await linesOf(required(rows.at(-1)?.registerId ?? null))).toEqual([['2230', 60, 0], ['4430', 0, 60]]);
      expect((await k.fin.salesPosting.liabilityReconciliation(k.companyId)).find((r) => r.label === 'Gift cards')?.diffCents).toBe(0);
    });

    it('a missing account fails the posting with the reason and posts once fixed', async () => {
      await k.db.update(k.schema.customerPostingGroups).set({ giftCardLiabilityAccountId: null }).where(eq(k.schema.customerPostingGroups.companyId, k.companyId));
      await issue(40, { kind: 'complimentary' });
      const out = await k.fin.salesPosting.processDue();
      expect(out.failed).toBeGreaterThan(0);
      const bad = (await queued('gift_card_issue')).find((r) => r.status === 'failed');
      expect(bad?.lastError).toContain('gift_card_liability');
      await k.db.update(k.schema.customerPostingGroups).set({ giftCardLiabilityAccountId: k.acct['2230'] }).where(eq(k.schema.customerPostingGroups.companyId, k.companyId));
      const retried = await k.fin.salesPosting.retry(k.ctx, required(bad?.id ?? null));
      expect(retried.failed).toBe(0);
      expect((await queued('gift_card_issue')).every((r) => r.status === 'posted')).toBe(true);
    });
  });
});
