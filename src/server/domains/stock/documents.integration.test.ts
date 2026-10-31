import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import { settleFinanceBacklog } from './test-support';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as InventoryModule from '@/server/domains/inventory/service';

/**
 * Transfers and counts against a real database: the states, the stock in transit, partial and short deliveries, a count that goes on
 * while the shop sells, and the rule that a transfer never changes what the company owns.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('transfers and counts (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let inv: typeof InventoryModule;
  let companyId: string;
  let itemTypeId: string;
  let main: string;
  let shop: string;
  const alice = { id: 'alice' };
  const bob = { id: 'bob' };

  const newProduct = async (stock = 0, cost = '40') => {
    const id = `prod_dc_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `DC-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `DCS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Doc ${id.slice(-6)}`, slug: `dc-${randomUUID()}`, itemTypeId, price: '100', costPrice: cost, stockQuantity: 0, taxRate: '0', isTaxInclusive: true });
    // Stock the way the application puts it there: a movement in the ledger and a line in the old journal.
    if (stock > 0) await db.transaction((tx) => inv.applyStockDelta(tx, { productId: id, delta: stock, costPrice: Number(cost), changeType: 'purchase_order_receipt', referenceId: `GRN-${randomUUID().slice(0, 6)}`, actor: 'tester', note: 'seed' }));
    return id;
  };
  const put = (productId: string, quantity: number, locationId = main) =>
    db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId, type: 'receipt', quantity, unitCost: 40, actor: { type: 'job' } }));
  const at = async (productId: string, locationId: string) => (await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId)))).reduce((a, r) => a + r.onHand, 0);
  const total = async (productId: string) => (await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.productId, productId))).reduce((a, r) => a + r.onHand, 0);
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };
  const history = async (documentId: string) => (await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, documentId)).orderBy(schema.decisionLog.occurredAt)).map((r) => [r.action, r.fromState, r.toState, r.actorId]);
  const makeTransfer = async (lines: { productId: string; quantity: number }[], from = main, to = shop, who = alice) => (await c.stockTransfers.create(companyId, who, { fromLocationId: from, toLocationId: to, lines })).id;
  const shipped = async (lines: { productId: string; quantity: number }[]) => {
    const id = await makeTransfer(lines);
    await c.stockTransfers.request(companyId, alice, id);
    await c.stockTransfers.ship(companyId, bob, id);
    return id;
  };
  const view = (id: string) => c.stockTransfers.get(companyId, id);

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    inv = await import('@/server/domains/inventory/service');
    companyId = (await c.companySettings.ensureSeeded()).id;
    itemTypeId = `it_dc_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
    shop = (await c.stockLocations.create(companyId, { code: `SH${randomUUID().slice(0, 6)}`, name: 'Town shop', kind: 'store' })).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  });
  afterAll(async () => {
    await db.update(schema.stockSettings).set({ transferRequiresApproval: false, countApprovalValue: '0' }).where(eq(schema.stockSettings.companyId, companyId));
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
  }, 120_000);

  describe('before the new ledger is the truth', () => {
    it('refuses transfers and counts, in words, and moves nothing', async () => {
      await c.stockSettings.setLedgerMode(companyId, false);
      try {
        const p = await newProduct(0);
        expect(await codeOf(c.stockTransfers.create(companyId, alice, { fromLocationId: main, toLocationId: shop, lines: [{ productId: p, quantity: 1 }] }))).toBe('LEDGER_OFF');
        expect(await codeOf(c.stockCounts.open(companyId, alice, { locationId: main, mode: 'cycle', productIds: [p] }))).toBe('LEDGER_OFF');
      } finally {
        await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      }
    });
  });

  describe('making a transfer', () => {
    it('is a numbered draft with its lines, and nothing moves yet', async () => {
      const p = await newProduct(10);
      const made = await c.stockTransfers.create(companyId, alice, { fromLocationId: main, toLocationId: shop, note: 'for the weekend', lines: [{ productId: p, quantity: 4 }] });
      expect(made.number).toMatch(/^TRF-/);
      const v = await view(made.id);
      expect(v.document).toMatchObject({ kind: 'transfer', state: 'draft', fromLocationId: main, toLocationId: shop, note: 'for the weekend', createdBy: 'alice', version: 1 });
      expect(v.lines).toMatchObject([{ productId: p, quantity: 4, shippedQuantity: 0, inTransit: 0 }]);
      expect(await at(p, main)).toBe(10);
      expect(await history(made.id)).toEqual([['stock.transfer.created', null, 'draft', 'alice']]);
    });

    it.each([
      ['the same place twice', (p: string) => ({ fromLocationId: main, toLocationId: main, lines: [{ productId: p, quantity: 1 }] }), 'SAME_PLACE'],
      ['no lines', () => ({ fromLocationId: main, toLocationId: shop, lines: [] }), 'BAD_LINES'],
      ['a product twice', (p: string) => ({ fromLocationId: main, toLocationId: shop, lines: [{ productId: p, quantity: 1 }, { productId: p, quantity: 2 }] }), 'BAD_LINES'],
      ['a product that does not exist', () => ({ fromLocationId: main, toLocationId: shop, lines: [{ productId: 'prod_nope', quantity: 1 }] }), 'NO_PRODUCT'],
      ['a fraction of a piece', (p: string) => ({ fromLocationId: main, toLocationId: shop, lines: [{ productId: p, quantity: 1.5 }] }), 'BAD_QUANTITY'],
      ['a place that does not exist', (p: string) => ({ fromLocationId: randomUUID(), toLocationId: shop, lines: [{ productId: p, quantity: 1 }] }), 'NOT_FOUND'],
    ])('is refused for %s', async (_name, input, code) => {
      const p = await newProduct(5);
      expect(await codeOf(c.stockTransfers.create(companyId, alice, input(p)))).toBe(code);
    });

    it('cannot use a stopped place or a transit place', async () => {
      const p = await newProduct(5);
      const stopped = await c.stockLocations.create(companyId, { code: `ST${randomUUID().slice(0, 6)}`, name: 'Stopped', kind: 'store' });
      await c.stockLocations.deactivate(companyId, stopped.id);
      expect(await codeOf(c.stockTransfers.create(companyId, alice, { fromLocationId: main, toLocationId: stopped.id, lines: [{ productId: p, quantity: 1 }] }))).toBe('INACTIVE');
      const id = await shipped([{ productId: p, quantity: 1 }]);
      const transit = (await view(id)).document.transitLocationId ?? '';
      expect(await codeOf(c.stockTransfers.create(companyId, alice, { fromLocationId: transit, toLocationId: shop, lines: [{ productId: p, quantity: 1 }] }))).toBe('IS_TRANSIT');
    });

    it('can be changed while a draft, by someone who has seen the latest version, and not afterwards', async () => {
      const [a, b] = [await newProduct(10), await newProduct(10)];
      const id = await makeTransfer([{ productId: a, quantity: 2 }]);
      await c.stockTransfers.updateDraft(companyId, bob, id, 1, { fromLocationId: main, toLocationId: shop, note: 'changed', lines: [{ productId: a, quantity: 3 }, { productId: b, quantity: 1 }] });
      expect((await view(id)).lines.map((l) => [l.productId, l.quantity, l.lineNo])).toEqual([[a, 3, 1], [b, 1, 2]]);
      expect((await view(id)).document).toMatchObject({ version: 2, note: 'changed' });
      expect(await codeOf(c.stockTransfers.updateDraft(companyId, alice, id, 1, { fromLocationId: main, toLocationId: shop, lines: [{ productId: a, quantity: 9 }] }))).toBe('CHANGED');
      await c.stockTransfers.request(companyId, alice, id);
      expect(await codeOf(c.stockTransfers.updateDraft(companyId, alice, id, 3, { fromLocationId: main, toLocationId: shop, lines: [{ productId: a, quantity: 9 }] }))).toBe('WRONG_STATE');
    });
  });

  describe('sending it', () => {
    it('moves the stock into a transit place made for the transfer, at cost, and the company owns the same as before', async () => {
      const p = await newProduct(10, '55');
      const before = await total(p);
      const id = await makeTransfer([{ productId: p, quantity: 4 }]);
      await c.stockTransfers.request(companyId, alice, id);
      const { transitLocationId } = await c.stockTransfers.ship(companyId, bob, id);
      expect(await at(p, main)).toBe(6);
      expect(await at(p, shop)).toBe(0);
      expect(await at(p, transitLocationId)).toBe(4);
      expect(await total(p)).toBe(before);
      const v = await view(id);
      expect(v.document).toMatchObject({ state: 'shipped', shippedBy: 'bob', transitLocationId });
      expect(v.document.shippedAt).toBeInstanceOf(Date);
      expect(v.lines[0]).toMatchObject({ shippedQuantity: 4, unitCost: '55.0000', inTransit: 4 });
      const [t] = await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, transitLocationId));
      expect(t).toMatchObject({ kind: 'transit', isSellable: false, sellsChannels: [], isActive: true, code: `TRN-${v.document.number}` });
      const moves = await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.productId, p), eq(schema.stockMovements.documentType, 'stock_transfer'))).orderBy(schema.stockMovements.id);
      expect(moves.map((m) => [m.movementType, m.quantity, m.unitCost])).toEqual([['transfer_out', -4, '55.0000'], ['transfer_in', 4, '55.0000']]);
    });

    it('is not available to customers while it is on its way', async () => {
      const p = await newProduct(10);
      await shipped([{ productId: p, quantity: 10 }]);
      expect((await c.stockAvailability.forProduct(p, 'ecommerce')).available).toBe(0);
    });

    it('can ship less than was asked for, and not more', async () => {
      const p = await newProduct(10);
      const id = await makeTransfer([{ productId: p, quantity: 6 }]);
      await c.stockTransfers.request(companyId, alice, id);
      const line = (await view(id)).lines[0]?.id ?? '';
      expect(await codeOf(c.stockTransfers.ship(companyId, bob, id, [{ lineId: line, quantity: 7 }]))).toBe('BAD_QUANTITY');
      expect(await codeOf(c.stockTransfers.ship(companyId, bob, id, [{ lineId: line, quantity: 0 }]))).toBe('NOTHING_TO_SHIP');
      expect(await codeOf(c.stockTransfers.ship(companyId, bob, id, [{ lineId: randomUUID(), quantity: 1 }]))).toBe('NO_LINE');
      await c.stockTransfers.ship(companyId, bob, id, [{ lineId: line, quantity: 2 }]);
      expect((await view(id)).lines[0]).toMatchObject({ quantity: 6, shippedQuantity: 2, inTransit: 2 });
      expect(await at(p, main)).toBe(8);
    });

    it('is refused for stock that is not there or is promised to a customer, and then nothing happened', async () => {
      const p = await newProduct(5);
      const id = await makeTransfer([{ productId: p, quantity: 5 }]);
      await c.stockTransfers.request(companyId, alice, id);
      const held = await c.stockReservations.reserve({ companyId, refType: 'order', refId: `ord_${randomUUID()}`, lines: [{ productId: p, quantity: 3 }], channel: 'ecommerce', actor: 't' });
      expect(held.ok).toBe(true);
      const problem = await c.stockTransfers.ship(companyId, bob, id).catch((e: unknown) => e as Error);
      expect(problem).toMatchObject({ code: 'INSUFFICIENT' });
      expect((problem as Error).message).toContain('2 of');
      expect(await at(p, main)).toBe(5);
      expect((await view(id)).document.state).toBe('requested');
      const locs = await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.code, `TRN-${(await view(id)).document.number}`));
      expect(locs).toEqual([]);
    });

    it('waits for a second person when the company asks for approval, who is not the one who asked', async () => {
      await db.update(schema.stockSettings).set({ transferRequiresApproval: true }).where(eq(schema.stockSettings.companyId, companyId));
      try {
        const p = await newProduct(5);
        const id = await makeTransfer([{ productId: p, quantity: 1 }]);
        await c.stockTransfers.request(companyId, alice, id);
        expect(await codeOf(c.stockTransfers.ship(companyId, bob, id))).toBe('NEEDS_APPROVAL');
        expect(await codeOf(c.stockTransfers.approve(companyId, alice, id))).toBe('SAME_PERSON');
        await c.stockTransfers.approve(companyId, bob, id);
        await c.stockTransfers.ship(companyId, alice, id);
        expect((await view(id)).document).toMatchObject({ state: 'shipped', approvedBy: 'bob' });
        expect((await history(id)).map((h) => h[0])).toEqual(['stock.transfer.created', 'stock.transfer.requested', 'stock.transfer.approved', 'stock.transfer.shipped']);
      } finally {
        await db.update(schema.stockSettings).set({ transferRequiresApproval: false }).where(eq(schema.stockSettings.companyId, companyId));
      }
    });

    it('can be cancelled until it ships, with a reason, and never after', async () => {
      const p = await newProduct(5);
      const id = await makeTransfer([{ productId: p, quantity: 1 }]);
      expect(await codeOf(c.stockTransfers.cancel(companyId, alice, id, ' '))).toBe('REASON_NEEDED');
      await c.stockTransfers.cancel(companyId, alice, id, 'plans changed');
      expect((await view(id)).document).toMatchObject({ state: 'cancelled', cancelledBy: 'alice', cancelReason: 'plans changed' });
      expect(await codeOf(c.stockTransfers.request(companyId, alice, id))).toBe('WRONG_STATE');
      const sent = await shipped([{ productId: p, quantity: 1 }]);
      expect(await codeOf(c.stockTransfers.cancel(companyId, alice, sent, 'too late'))).toBe('WRONG_STATE');
    });
  });

  describe('receiving it', () => {
    it('in two parts: partly received, then received, with the transit place stopped at the end', async () => {
      const p = await newProduct(10);
      const id = await shipped([{ productId: p, quantity: 10 }]);
      const line = (await view(id)).lines[0]?.id ?? '';
      expect(await c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 6 }])).toEqual({ state: 'partly_received' });
      expect(await at(p, shop)).toBe(6);
      expect((await view(id)).lines[0]).toMatchObject({ receivedQuantity: 6, inTransit: 4 });
      expect(await c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 4 }])).toEqual({ state: 'received' });
      expect(await at(p, shop)).toBe(10);
      expect(await at(p, main)).toBe(0);
      const v = await view(id);
      expect(v.document.closedAt).toBeInstanceOf(Date);
      expect(v.document.lastReceivedAt).toBeInstanceOf(Date);
      const [t] = await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, v.document.transitLocationId ?? ''));
      expect(t?.isActive).toBe(false);
      expect(await at(p, v.document.transitLocationId ?? '')).toBe(0);
    });

    it('is refused for more than is on its way, for nothing, and for a line that is not on the transfer', async () => {
      const p = await newProduct(10);
      const id = await shipped([{ productId: p, quantity: 5 }]);
      const line = (await view(id)).lines[0]?.id ?? '';
      expect(await codeOf(c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 6 }]))).toBe('TOO_MUCH');
      expect(await codeOf(c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 0 }]))).toBe('BAD_QUANTITY');
      expect(await codeOf(c.stockTransfers.receive(companyId, bob, id, []))).toBe('NOTHING_TO_RECEIVE');
      expect(await codeOf(c.stockTransfers.receive(companyId, bob, id, [{ lineId: randomUUID(), quantity: 1 }]))).toBe('NO_LINE');
      expect(await codeOf(c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 1 }, { lineId: line, quantity: 1 }]))).toBe('NO_LINE');
      expect(await at(p, shop)).toBe(0);
    });

    it('cannot be received twice in full: the second try finds nothing on its way', async () => {
      const p = await newProduct(4);
      const id = await shipped([{ productId: p, quantity: 4 }]);
      const line = (await view(id)).lines[0]?.id ?? '';
      const tries = await Promise.all([codeOf(c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 4 }])), codeOf(c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 4 }]))]);
      expect(tries.filter((t) => t === 'OK')).toHaveLength(1);
      expect(await at(p, shop)).toBe(4);
    });
  });

  describe('what does not arrive', () => {
    it('is written off with a reason: the company owns less, the old journal says so, and the transfer closes', async () => {
      const p = await newProduct(10);
      const id = await shipped([{ productId: p, quantity: 10 }]);
      const line = (await view(id)).lines[0]?.id ?? '';
      await c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 7 }]);
      expect(await codeOf(c.stockTransfers.resolve(companyId, bob, id, [{ lineId: line, quantity: 3, action: 'write_off' }], ''))).toBe('REASON_NEEDED');
      expect(await c.stockTransfers.resolve(companyId, bob, id, [{ lineId: line, quantity: 3, action: 'write_off' }], 'van was robbed')).toEqual({ state: 'closed' });
      expect(await total(p)).toBe(7);
      expect((await view(id)).lines[0]).toMatchObject({ receivedQuantity: 7, writtenOffQuantity: 3, inTransit: 0 });
      const lost = await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.productId, p), eq(schema.stockMovements.movementType, 'write_off')));
      expect(lost).toMatchObject([{ quantity: -3, reasonCode: 'lost_in_transit' }]);
      const journal = await db.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.productId, p), eq(schema.inventoryMovements.changeType, 'damage_writeoff')));
      expect(journal).toMatchObject([{ changeAmount: -3, previousStock: 10, newStock: 7 }]);
      expect((await c.stockShadow.compare({ productIds: [p] })).journalDiffers).toBe(0);
      const last = (await history(id)).at(-1);
      expect(last).toEqual(['stock.transfer.settled', 'partly_received', 'closed', 'bob']);
    });

    it('can be sent back to the sender instead, and then the company owns the same as at the start', async () => {
      const p = await newProduct(10);
      const id = await shipped([{ productId: p, quantity: 10 }]);
      const line = (await view(id)).lines[0]?.id ?? '';
      expect(await c.stockTransfers.resolve(companyId, bob, id, [{ lineId: line, quantity: 10, action: 'return_to_source' }], 'refused at the door')).toEqual({ state: 'closed' });
      expect(await at(p, main)).toBe(10);
      expect(await total(p)).toBe(10);
      expect(await codeOf(c.stockTransfers.resolve(companyId, bob, id, [{ lineId: line, quantity: 1, action: 'write_off' }], 'again'))).toBe('WRONG_STATE');
    });

    it('is refused for more than is on its way or an unknown action', async () => {
      const p = await newProduct(5);
      const id = await shipped([{ productId: p, quantity: 5 }]);
      const line = (await view(id)).lines[0]?.id ?? '';
      expect(await codeOf(c.stockTransfers.resolve(companyId, bob, id, [{ lineId: line, quantity: 6, action: 'write_off' }], 'x'))).toBe('BAD_QUANTITY');
      expect(await codeOf(c.stockTransfers.resolve(companyId, bob, id, [{ lineId: line, quantity: 1, action: 'burn' as 'write_off' }], 'x'))).toBe('BAD_ACTION');
      expect(await total(p)).toBe(5);
    });
  });

  describe('a finished document', () => {
    it('cannot be changed by anyone, even directly in the database', async () => {
      const p = await newProduct(3);
      const id = await shipped([{ productId: p, quantity: 3 }]);
      const line = (await view(id)).lines[0]?.id ?? '';
      await c.stockTransfers.receive(companyId, bob, id, [{ lineId: line, quantity: 3 }]);
      await expect(db.update(schema.stockDocuments).set({ note: 'edited' }).where(eq(schema.stockDocuments.id, id))).rejects.toThrow();
      await expect(db.update(schema.stockDocumentLines).set({ quantity: 99 }).where(eq(schema.stockDocumentLines.id, line))).rejects.toThrow();
      await expect(db.delete(schema.stockDocuments).where(eq(schema.stockDocuments.id, id))).rejects.toThrow();
    });

    it('keeps the lines of a document that has left draft', async () => {
      const p = await newProduct(3);
      const id = await makeTransfer([{ productId: p, quantity: 1 }]);
      await c.stockTransfers.request(companyId, alice, id);
      await expect(db.delete(schema.stockDocumentLines).where(eq(schema.stockDocumentLines.documentId, id))).rejects.toThrow();
    });
  });

  describe('conservation', () => {
    it('holds over any run of transfers, receipts and send-backs: what the company owns changes only by a loss', async () => {
      const products = await Promise.all([newProduct(30), newProduct(30), newProduct(30)]);
      const owned = async () => (await Promise.all(products.map((p) => total(p)))).reduce((a, b) => a + b, 0);
      let lost = 0;
      let seed = 11;
      const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
      const open: string[] = [];
      for (let i = 0; i < 24; i++) {
        const roll = next();
        if (open.length === 0 || roll < 0.45) {
          const p = products[Math.floor(next() * products.length)] ?? '';
          const q = 1 + Math.floor(next() * 4);
          const from = next() < 0.5 ? main : shop;
          const to = from === main ? shop : main;
          const id = await makeTransfer([{ productId: p, quantity: q }], from, to);
          await c.stockTransfers.request(companyId, alice, id);
          if ((await codeOf(c.stockTransfers.ship(companyId, bob, id))) === 'OK') open.push(id);
        } else {
          const id = open[Math.floor(next() * open.length)] ?? '';
          const v = await view(id);
          const l = v.lines[0];
          if (l === undefined || l.inTransit <= 0) continue;
          const q = Math.max(1, Math.floor(l.inTransit * next()));
          const action = next();
          if (action < 0.6) await c.stockTransfers.receive(companyId, bob, id, [{ lineId: l.id, quantity: q }]);
          else if (action < 0.85) await c.stockTransfers.resolve(companyId, bob, id, [{ lineId: l.id, quantity: q, action: 'return_to_source' }], 'back');
          else {
            await c.stockTransfers.resolve(companyId, bob, id, [{ lineId: l.id, quantity: q, action: 'write_off' }], 'lost');
            lost += q;
          }
          if ((await view(id)).lines[0]?.inTransit === 0) open.splice(open.indexOf(id), 1);
        }
        expect(await owned(), `after step ${String(i)}`).toBe(90 - lost);
      }
    });
  });

  describe('counting', () => {
    const open = (productIds: string[], over: Record<string, unknown> = {}) => c.stockCounts.open(companyId, alice, { locationId: main, mode: 'cycle', productIds, ...over });
    const found = async (id: string) => Object.fromEntries((await c.stockCounts.get(companyId, id)).lines.map((l) => [l.line.productId, l.variance]));

    it('remembers what was expected when it opened, and lists only the products asked for in a cycle count', async () => {
      const [a, b] = [await newProduct(10), await newProduct(5)];
      const made = await open([a, b]);
      expect(made.number).toMatch(/^CNT-/);
      expect(made.lines).toBe(2);
      const v = await c.stockCounts.get(companyId, made.id);
      expect(v.document).toMatchObject({ kind: 'count', state: 'counting', countMode: 'cycle', blind: false, fromLocationId: main });
      expect(v.lines.map((l) => [l.line.productId, l.expected])).toEqual([[a, 10], [b, 5]].sort());
      expect(await codeOf(c.stockCounts.open(companyId, alice, { locationId: main, mode: 'cycle', productIds: [] }))).toBe('NO_PRODUCTS');
      expect(await codeOf(c.stockCounts.open(companyId, alice, { locationId: main, mode: 'cycle', productIds: ['prod_nope'] }))).toBe('NO_PRODUCT');
      expect(await codeOf(c.stockCounts.open(companyId, alice, { locationId: main, mode: 'weekly' }))).toBe('BAD_MODE');
    });

    it('a full count lists every product with stock at the place, and none without', async () => {
      const lonely = await c.stockLocations.create(companyId, { code: `CN${randomUUID().slice(0, 6)}`, name: 'Cold room', kind: 'warehouse' });
      const [a, b, none] = [await newProduct(0), await newProduct(0), await newProduct(0)];
      await put(a, 3, lonely.id);
      await put(b, 8, lonely.id);
      await put(none, 4, main);
      const made = await c.stockCounts.open(companyId, alice, { locationId: lonely.id, mode: 'full' });
      expect(made.lines).toBe(2);
      expect((await c.stockCounts.get(companyId, made.id)).lines.map((l) => l.line.productId).sort()).toEqual([a, b].sort());
    });

    it('posts only the differences: what was found less what should have been there', async () => {
      const [a, b, d] = [await newProduct(10), await newProduct(10), await newProduct(10)];
      const made = await open([a, b, d]);
      await c.stockCounts.record(companyId, bob, made.id, [{ productId: a, quantity: 8 }, { productId: b, quantity: 10 }, { productId: d, quantity: 12 }]);
      await c.stockCounts.submit(companyId, bob, made.id);
      expect(await found(made.id)).toEqual({ [a]: -2, [b]: 0, [d]: 2 });
      expect(await c.stockCounts.post(companyId, alice, made.id)).toEqual({ adjusted: 2 });
      expect([await at(a, main), await at(b, main), await at(d, main)]).toEqual([8, 10, 12]);
      const v = await c.stockCounts.get(companyId, made.id);
      expect(v.document).toMatchObject({ state: 'posted', postedBy: 'alice' });
      expect(v.lines.map((l) => l.line.varianceQuantity).sort()).toEqual([-2, 0, 2]);
      const moves = await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.documentType, 'stock_count'), eq(schema.stockMovements.documentId, made.id)));
      expect(moves.map((m) => [m.movementType, m.quantity]).sort()).toEqual([['count_variance', -2], ['count_variance', 2]]);
      expect((await c.stockShadow.compare({ productIds: [a, b, d] })).journalDiffers).toBe(0);
    });

    it('does not need the shop to stop: a sale made while counting is not a loss', async () => {
      const p = await newProduct(10);
      const made = await open([p]);
      // Three are sold, then the shelf is counted: seven are there, as there should be.
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: main, type: 'sale_issue', quantity: -3, actor: { type: 'job' } }));
      await new Promise((r) => setTimeout(r, 15));
      await c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: 7 }]);
      await c.stockCounts.submit(companyId, bob, made.id);
      expect((await c.stockCounts.get(companyId, made.id)).lines[0]).toMatchObject({ expected: 10, movedSince: -3, variance: 0 });
      // Two more go after the shelf was counted: they stay sold, and the count does not put them back.
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: main, type: 'sale_issue', quantity: -2, actor: { type: 'job' } }));
      expect(await c.stockCounts.post(companyId, alice, made.id)).toEqual({ adjusted: 0 });
      expect(await at(p, main)).toBe(5);
    });

    it('finds a real loss even with sales going on', async () => {
      const p = await newProduct(10);
      const made = await open([p]);
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: main, type: 'sale_issue', quantity: -3, actor: { type: 'job' } }));
      await new Promise((r) => setTimeout(r, 15));
      await c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: 6 }]);
      await c.stockCounts.submit(companyId, bob, made.id);
      expect((await c.stockCounts.get(companyId, made.id)).lines[0]?.variance).toBe(-1);
      await c.stockCounts.post(companyId, alice, made.id);
      expect(await at(p, main)).toBe(6);
    });

    it('hides the expected figures from the counter of a blind count until it is handed in', async () => {
      const p = await newProduct(10);
      const made = await open([p], { blind: true });
      expect((await c.stockCounts.get(companyId, made.id)).lines[0]).toMatchObject({ expected: null, movedSince: null, variance: null });
      await c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: 9 }]);
      await c.stockCounts.submit(companyId, bob, made.id);
      expect((await c.stockCounts.get(companyId, made.id)).lines[0]).toMatchObject({ expected: 10, variance: -1 });
    });

    it('adds a product that was not on the list, expected at what the ledger said', async () => {
      const [listed, extra] = [await newProduct(4), await newProduct(6)];
      const made = await open([listed]);
      await c.stockCounts.record(companyId, bob, made.id, [{ productId: listed, quantity: 4 }, { productId: extra, quantity: 5 }]);
      await c.stockCounts.submit(companyId, bob, made.id);
      expect(await found(made.id)).toEqual({ [listed]: 0, [extra]: -1 });
    });

    it('records who counted each line and when, and can be sent back to correct a figure', async () => {
      const p = await newProduct(4);
      const made = await open([p]);
      await c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: 3 }]);
      const [l] = (await c.stockCounts.get(companyId, made.id)).lines;
      expect(l?.line).toMatchObject({ countedQuantity: 3, countedBy: 'bob' });
      expect(l?.line.countedAt).toBeInstanceOf(Date);
      await c.stockCounts.submit(companyId, bob, made.id);
      expect(await codeOf(c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: 4 }]))).toBe('WRONG_STATE');
      await c.stockCounts.reopen(companyId, alice, made.id);
      await c.stockCounts.record(companyId, alice, made.id, [{ productId: p, quantity: 4 }]);
      await c.stockCounts.submit(companyId, alice, made.id);
      expect(await found(made.id)).toEqual({ [p]: 0 });
    });

    it('needs a second person, who took no part, when the differences are worth more than the limit', async () => {
      await db.update(schema.stockSettings).set({ countApprovalValue: '100' }).where(eq(schema.stockSettings.companyId, companyId));
      try {
        const p = await newProduct(10, '50');
        const made = await open([p]);
        await c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: 7 }]);
        await c.stockCounts.submit(companyId, bob, made.id);
        const v = await c.stockCounts.get(companyId, made.id);
        expect(v).toMatchObject({ varianceValue: 150, needsApproval: true });
        expect(await codeOf(c.stockCounts.post(companyId, alice, made.id))).toBe('NEEDS_APPROVAL');
        expect(await codeOf(c.stockCounts.approve(companyId, bob, made.id))).toBe('SAME_PERSON');
        expect(await codeOf(c.stockCounts.approve(companyId, alice, made.id))).toBe('SAME_PERSON');
        await c.stockCounts.approve(companyId, { id: 'carol' }, made.id);
        await c.stockCounts.post(companyId, { id: 'carol' }, made.id);
        expect(await at(p, main)).toBe(7);
        expect((await history(made.id)).map((h) => h[2])).toEqual(['counting', 'counted', 'approved', 'posted']);
      } finally {
        await db.update(schema.stockSettings).set({ countApprovalValue: '0' }).where(eq(schema.stockSettings.companyId, companyId));
      }
    });

    it('cannot be posted twice, handed in empty, or counted into once handed in; and a cancelled one stays cancelled', async () => {
      const p = await newProduct(4);
      const made = await open([p]);
      expect(await codeOf(c.stockCounts.submit(companyId, bob, made.id))).toBe('NOTHING_COUNTED');
      await c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: 3 }]);
      await c.stockCounts.submit(companyId, bob, made.id);
      const posts = await Promise.all([codeOf(c.stockCounts.post(companyId, alice, made.id)), codeOf(c.stockCounts.post(companyId, alice, made.id))]);
      expect(posts.filter((x) => x === 'OK')).toHaveLength(1);
      expect(await at(p, main)).toBe(3);
      const other = await open([p]);
      await c.stockCounts.cancel(companyId, alice, other.id, 'wrong shelf');
      expect(await codeOf(c.stockCounts.record(companyId, alice, other.id, [{ productId: p, quantity: 1 }]))).toBe('WRONG_STATE');
      expect(await codeOf(c.stockCounts.cancel(companyId, alice, other.id, 'again'))).toBe('WRONG_STATE');
    });

    it('refuses a counted quantity that is negative, fractional of a piece, or for a product that is gone', async () => {
      const p = await newProduct(4);
      const made = await open([p]);
      expect(await codeOf(c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: -1 }]))).toBe('BAD_LINES');
      expect(await codeOf(c.stockCounts.record(companyId, bob, made.id, [{ productId: p, quantity: 2.5 }]))).toBe('BAD_QUANTITY');
      expect(await codeOf(c.stockCounts.record(companyId, bob, made.id, [{ productId: 'prod_nope', quantity: 1 }]))).toBe('NO_PRODUCT');
    });
  });

  describe('another company', () => {
    it('cannot see or move this company’s documents', async () => {
      const p = await newProduct(5);
      const id = await makeTransfer([{ productId: p, quantity: 1 }]);
      const stranger = randomUUID();
      expect(await codeOf(c.stockTransfers.get(stranger, id))).toBe('NOT_FOUND');
      expect(await codeOf(c.stockTransfers.request(stranger, alice, id))).toBe('NOT_FOUND');
      const made = await c.stockCounts.open(companyId, alice, { locationId: main, mode: 'cycle', productIds: [p] });
      expect(await codeOf(c.stockCounts.get(stranger, made.id))).toBe('NOT_FOUND');
      expect(await codeOf(c.stockCounts.post(stranger, alice, made.id))).toBe('NOT_FOUND');
    });
  });
});
