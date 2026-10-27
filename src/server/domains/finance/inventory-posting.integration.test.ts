import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { has, required } from '@/lib/values';
import { refundKit } from './refund-test-kit';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
describe.skipIf(!has(process.env.TEST_DATABASE_URL))('stock at cost in the books (database)', () => {
  const k = refundKit('STK');
  const run = randomUUID().slice(0, 6);
  const mine: string[] = [];
  let tomorrow: string;
  let stamp: Date;

  /**
   * The test database is shared with every other test, and stock is not owned by a company, so movements made elsewhere
   * while this runs would be written down too. The books here start tomorrow: what other tests do today is skipped as
   * "before go-live", and everything this test moves is dated tomorrow, so only its own changes reach its books.
   */
  beforeAll(async () => {
    tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
    stamp = new Date(`${tomorrow}T12:00:00+03:00`);
    await k.db.update(k.schema.financeSettings).set({ inventoryGlGoLive: tomorrow }).where(eq(k.schema.financeSettings.companyId, k.companyId));
  });

  async function product(stock: number, cost: string) {
    const itemTypeId = `it_${run}_${mine.length}`;
    await k.db.insert(k.schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await k.db.insert(k.schema.products).values({ id, sku: `INV-${run}-${mine.length}`.toUpperCase(), stockCode: `INVS-${run}-${mine.length}`.toUpperCase(), name: `Stock ${mine.length}`, slug: `inv-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    mine.push(id);
    return id;
  }
  /** Moves stock the way the system does: the product changes, then the movement is written down. */
  async function move(productId: string, delta: number, changeType: string) {
    await k.db.transaction(async (tx) => {
      const [p] = await tx.select().from(k.schema.products).where(eq(k.schema.products.id, productId)).for('update');
      const next = p.stockQuantity + delta;
      await tx.update(k.schema.products).set({ stockQuantity: next }).where(eq(k.schema.products.id, productId));
      await tx.insert(k.schema.inventoryMovements).values({ id: `mv_${randomUUID()}`, productId, productName: p.name, changeAmount: delta, previousStock: p.stockQuantity, newStock: next, changeType, referenceId: `T-${run}`, createdAt: stamp });
    });
  }
  const events = (productId: string) => k.db.select().from(k.schema.financeInventoryEvents).where(and(eq(k.schema.financeInventoryEvents.companyId, k.companyId), eq(k.schema.financeInventoryEvents.productId, productId))).orderBy(k.schema.financeInventoryEvents.id);
  /**
   * Posts everything that is due, not just the oldest 1000: the database is shared with the other test files, and by the time this
   * one runs they can already have left more than that waiting, which would push these events past the first batch.
   */
  const post = async () => {
    const batch = 1000;
    const total = { posted: 0, failed: 0 };
    for (let pass = 0; pass < 50; pass += 1) {
      const out = await k.fin.inventoryPosting.processDue(batch);
      total.posted += out.posted;
      total.failed += out.failed;
      if (out.posted + out.failed < batch) break;
    }
    return total;
  };
  const linesOf = async (registerId: string) => {
    const no = new Map(Object.entries(k.acct).map(([n, id]) => [id, n]));
    return (await k.db.select().from(k.schema.glEntries).where(eq(k.schema.glEntries.registerId, registerId))).map((l) => [no.get(l.accountId), Number(l.debit), Number(l.credit)]).sort();
  };
  const onlyMine = async (productId: string) => {
    await post();
    return await events(productId);
  };

  describe('what the database writes down', () => {
    it('writes a fraction of a unit exactly, and rounds only the money to cents', async () => {
      const id = await product(10, '33.33');
      await move(id, 0.125, 'purchase_order_receipt');
      await move(id, -2.5, 'damage_writeoff');
      const rows = await events(id);
      expect(rows.map((r) => [r.quantity, r.value])).toEqual([[0.125, '4.17'], [-2.5, '-83.33']]);
      // A change of cost revalues the 7.625 in hand.
      await k.db.update(k.schema.products).set({ costPrice: '34.00' }).where(eq(k.schema.products.id, id));
      const revaluation = (await events(id)).find((r) => r.kind === 'revaluation');
      expect(revaluation).toMatchObject({ quantity: 7.625, value: '5.11' });
    });

    it('keeps the books at units x cost to the cent over many small fractional changes, with a change of cost in between', async () => {
      const id = await product(0, '0.07');
      for (let i = 0; i < 25; i++) await move(id, 0.333, 'purchase_order_receipt');
      await k.db.update(k.schema.products).set({ costPrice: '0.11' }).where(eq(k.schema.products.id, id));
      for (let i = 0; i < 25; i++) await move(id, 0.333, 'purchase_order_receipt');
      await move(id, -1.111, 'damage_writeoff');
      const booked = (await events(id)).reduce((n, r) => n + Math.round(Number(r.value) * 100), 0);
      const [p] = await k.db.select().from(k.schema.products).where(eq(k.schema.products.id, id));
      // Written one by one to the cent, 51 changes of a few thousandths of a cent would drift; carried, they never do.
      expect(booked).toBe(Math.round(p.stockQuantity * Number(p.costPrice) * 100));
      const [totals] = await k.db.select().from(k.schema.financeInventoryTotals).where(and(eq(k.schema.financeInventoryTotals.companyId, k.companyId), eq(k.schema.financeInventoryTotals.productId, id)));
      expect(Math.round(Number(totals.bookedTotal) * 100)).toBe(booked);
    });

    it('writes a movement once, at the cost the goods had, and ignores reservations, releases and nothing-moved', async () => {
      const id = await product(10, '300.00');
      await move(id, 4, 'purchase_order_receipt');
      await k.db.insert(k.schema.inventoryMovements).values([
        { id: `mv_${randomUUID()}`, productId: id, productName: 'x', changeAmount: -2, previousStock: 14, newStock: 0, changeType: 'order_reservation', referenceId: 'R', createdAt: stamp },
        { id: `mv_${randomUUID()}`, productId: id, productName: 'x', changeAmount: 2, previousStock: 14, newStock: 14, changeType: 'order_cancellation_release', referenceId: 'R', createdAt: stamp },
        { id: `mv_${randomUUID()}`, productId: id, productName: 'x', changeAmount: 0, previousStock: 14, newStock: 14, changeType: 'manual_adjustment', referenceId: 'R', createdAt: stamp },
      ]);
      const rows = await events(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'movement', changeType: 'purchase_order_receipt', quantity: 4, unitCost: '300.00', value: '1200.00', eventDate: tomorrow, status: 'pending' });
    });

    it('writes a change of cost as a revaluation of the goods that were in hand', async () => {
      const id = await product(12, '300.00');
      await k.db.update(k.schema.products).set({ costPrice: '310.00' }).where(eq(k.schema.products.id, id));
      const rows = await events(id);
      // dated today, before this company's books start tomorrow
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'revaluation', changeType: 'cost_change', quantity: 12, unitCost: '10.00', value: '120.00' });
    });

    it('cannot be rewritten or deleted', async () => {
      const id = await product(1, '5.00');
      await move(id, 1, 'restock');
      const [e] = await events(id);
      await expect(k.db.update(k.schema.financeInventoryEvents).set({ value: '1.00' }).where(eq(k.schema.financeInventoryEvents.id, e.id))).rejects.toThrow();
      await expect(k.db.delete(k.schema.financeInventoryEvents).where(eq(k.schema.financeInventoryEvents.id, e.id))).rejects.toThrow();
    });
  });

  describe('taking changes to the ledger', () => {
    it('receipts build stock up against stock received not invoiced; sales go to cost of sales; returns undo it; counts go to adjustments', async () => {
      const id = await product(0, '300.00');
      await move(id, 4, 'purchase_order_receipt');
      await move(id, -3, 'order_fulfillment');
      await move(id, 1, 'credit_note_restock');
      await move(id, -2, 'physical_audit');
      await move(id, 2, 'manual_adjustment');
      await post();
      const rows = await events(id);
      expect(rows.map((r) => r.status)).toEqual(['posted', 'posted', 'posted', 'posted', 'posted']);
      expect(await Promise.all(rows.map(async (r) => await linesOf(required(r.registerId))))).toEqual([
        [['1310', 1200, 0], ['2130', 0, 1200]],
        [['1310', 0, 900], ['5100', 900, 0]],
        [['1310', 300, 0], ['5100', 0, 300]],
        [['1310', 0, 600], ['5200', 600, 0]],
        [['1310', 600, 0], ['5200', 0, 600]],
      ]);
    });

    it('a change of cost revalues the stock through the adjustment account, from the day it was made', async () => {
      await k.db.update(k.schema.financeSettings).set({ inventoryGlGoLive: '2000-01-01' }).where(eq(k.schema.financeSettings.companyId, k.companyId));
      const id = await product(5, '100.00');
      await k.db.update(k.schema.products).set({ costPrice: '120.00' }).where(eq(k.schema.products.id, id));
      const rows = await onlyMine(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('posted');
      expect(await linesOf(required(rows[0].registerId))).toEqual([['1310', 100, 0], ['5200', 0, 100]]);
      await k.db.update(k.schema.products).set({ costPrice: '110.00' }).where(eq(k.schema.products.id, id));
      const down = (await onlyMine(id)).at(-1);
      expect(await linesOf(required(down?.registerId ?? null))).toEqual([['1310', 0, 50], ['5200', 50, 0]]);
      await k.db.update(k.schema.financeSettings).set({ inventoryGlGoLive: tomorrow }).where(eq(k.schema.financeSettings.companyId, k.companyId));
    });

    it('goods that cost nothing have nothing to post, and a change before the books started is left out', async () => {
      const free = await product(0, '0.00');
      await move(free, 5, 'restock');
      const [zero] = await onlyMine(free);
      expect(zero).toMatchObject({ status: 'skipped' });
      expect(zero.lastError).toContain('no cost');
      const early = await product(5, '10.00');
      await k.db.update(k.schema.products).set({ costPrice: '11.00' }).where(eq(k.schema.products.id, early));
      const [old] = await onlyMine(early);
      expect(old).toMatchObject({ status: 'skipped' });
      expect(old.lastError).toContain('before stock went into the books');
    });

    it('posts an event once, even when asked twice at the same time', async () => {
      const id = await product(0, '50.00');
      await move(id, 2, 'restock');
      const [e] = await events(id);
      const out = await Promise.all([k.fin.inventoryPosting.attempt(e.id), k.fin.inventoryPosting.attempt(e.id)]);
      expect(out).toEqual([true, true]);
      const registers = await k.db.select().from(k.schema.ledgerRegisters).where(and(eq(k.schema.ledgerRegisters.companyId, k.companyId), eq(k.schema.ledgerRegisters.sourceId, String(e.id)), eq(k.schema.ledgerRegisters.documentType, 'stock_movement')));
      expect(registers).toHaveLength(1);
    });

    it('a missing account fails the change with the reason, keeps retrying, and posts once fixed', async () => {
      const id = await product(0, '20.00');
      await move(id, 3, 'restock');
      await k.db.update(k.schema.generalPostingSetup).set({ inventoryClearingAccountId: null }).where(eq(k.schema.generalPostingSetup.companyId, k.companyId));
      const out = await post();
      expect(out.failed).toBeGreaterThan(0);
      const [bad] = await events(id);
      expect(bad).toMatchObject({ status: 'failed', attempts: 1 });
      expect(bad.lastError).toContain('inventory_clearing');
      const ready = await k.fin.inventoryPosting.readiness(k.companyId);
      expect(ready.find((c) => c.key === 'inventory_clearing')).toMatchObject({ ok: false, blocking: true });
      await k.db.update(k.schema.generalPostingSetup).set({ inventoryClearingAccountId: k.acct['2130'] }).where(eq(k.schema.generalPostingSetup.companyId, k.companyId));
      expect(await k.fin.inventoryPosting.retry(k.ctx, bad.id)).toBe(true);
      expect((await events(id))[0].status).toBe('posted');
    });
  });

  describe('switching stock on', () => {
    it('refuses until the accounts are chosen, and an offset that is not equity', async () => {
      await k.db.update(k.schema.financeSettings).set({ inventoryGlGoLive: null }).where(eq(k.schema.financeSettings.companyId, k.companyId));
      await k.db.update(k.schema.generalPostingSetup).set({ inventoryAccountId: null }).where(eq(k.schema.generalPostingSetup.companyId, k.companyId));
      expect(await k.codeOf(k.fin.inventoryPosting.goLive(k.ctx, { offsetAccountId: k.acct['3100'] }))).toBe('NOT_READY');
      await k.db.update(k.schema.generalPostingSetup).set({ inventoryAccountId: k.acct['1310'] }).where(eq(k.schema.generalPostingSetup.companyId, k.companyId));
      expect(await k.codeOf(k.fin.inventoryPosting.goLive(k.ctx, { offsetAccountId: k.acct['4100'] }))).toBe('OFFSET_INVALID');
      expect(await k.codeOf(k.fin.inventoryPosting.goLive(k.ctx, { offsetAccountId: randomUUID() }))).toBe('OFFSET_INVALID');
    });

    it('brings the stock on hand in at cost against equity, once, and then posts what happens next', async () => {
      const before = await k.fin.inventoryPosting.stockValueCents();
      const mineId = await product(10, '300.00');
      const out = await k.fin.inventoryPosting.goLive(k.ctx, { offsetAccountId: k.acct['3100'] });
      // everything on the shelves at that moment, whoever's it is: at least what this test put there
      expect(out.openingCents).toBeGreaterThanOrEqual(before + 300000);
      const [opening] = await k.db.select().from(k.schema.ledgerRegisters).where(and(eq(k.schema.ledgerRegisters.companyId, k.companyId), eq(k.schema.ledgerRegisters.documentType, 'opening_balance'), eq(k.schema.ledgerRegisters.documentNo, 'OPEN-STOCK')));
      expect(await linesOf(opening.id)).toEqual([['1310', out.openingCents / 100, 0], ['3100', 0, out.openingCents / 100]]);
      const [s] = await k.db.select().from(k.schema.financeSettings).where(eq(k.schema.financeSettings.companyId, k.companyId));
      expect(s.inventoryGlGoLive).toBe(out.date);
      expect(await k.codeOf(k.fin.inventoryPosting.goLive(k.ctx, { offsetAccountId: k.acct['3100'] }))).toBe('ALREADY_LIVE');
      // from now on, what happens is written down and posted
      await k.db.transaction(async (tx) => {
        await tx.update(k.schema.products).set({ stockQuantity: 7 }).where(eq(k.schema.products.id, mineId));
        await tx.insert(k.schema.inventoryMovements).values({ id: `mv_${randomUUID()}`, productId: mineId, productName: 'x', changeAmount: -3, previousStock: 10, newStock: 7, changeType: 'order_fulfillment', referenceId: 'LIVE' });
      });
      const rows = await onlyMine(mineId);
      expect(rows.at(-1)).toMatchObject({ status: 'posted', value: '-900.00' });
      expect(await linesOf(required(rows.at(-1)?.registerId ?? null))).toEqual([['1310', 0, 900], ['5100', 900, 0]]);
      const live = await k.fin.inventoryPosting.reconciliation(k.companyId);
      expect(live.live).toBe(true);
    });
  });

  it('another company sees none of it', async () => {
    const id = await product(0, '9.00');
    await k.db.update(k.schema.financeSettings).set({ inventoryGlGoLive: tomorrow }).where(eq(k.schema.financeSettings.companyId, k.companyId));
    await move(id, 1, 'restock');
    const stranger = randomUUID();
    expect(await k.fin.inventoryPosting.readiness(stranger)).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'finance', ok: false })]));
    const overview = await k.fin.inventoryPosting.overview(stranger);
    expect(overview.counts).toEqual({});
    expect(overview.failed).toEqual([]);
  });
});
