import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { has, required } from '@/lib/values';
import { emptyUnitDraft } from '@/lib/unit-rules';
import type { ProductWrite } from '@/types/index';
import { refundKit } from '@/server/domains/finance/refund-test-kit';

/**
 * Credit notes and returns in the unit the goods were sold in, against a real database:
 * 3 crates of 20 kg fish are sold, a crate and a half come back, and the kilograms are what stock and money use.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
describe.skipIf(!has(process.env.TEST_DATABASE_URL))(
  'credit notes and returns in units (database)',
  () => {
    const k = refundKit('CRU');
    const tag = randomUUID().slice(0, 6).toUpperCase();
    let kg: string;
    let crate: string;
    let sack: string;
    let fishId: string;
    let seq = 0;

    const product = (over: Partial<ProductWrite>): ProductWrite => ({
      sku: `CU${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
      stockCode: `CS${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
      name: `Fish ${tag}`,
      slug: `fish-${randomUUID()}`,
      description: '',
      category: '',
      itemTypeId: '',
      itemTypeName: '',
      itemTypeCode: 0,
      isSellable: true,
      price: 300,
      costPrice: 200,
      taxRate: 0,
      isTaxInclusive: true,
      stockQuantity: 100,
      lowStockThreshold: 0,
      isActive: true,
      imageUrl: '',
      rating: 0,
      reviewCount: 0,
      tags: [],
      ...over,
    });

    beforeAll(async () => {
      const { CatalogService } = await import('@/server/domains/catalog/service');
      const idOf = async (code: string) =>
        required(
          (
            await k.db
              .select()
              .from(k.schema.unitsOfMeasure)
              .where(eq(k.schema.unitsOfMeasure.code, code))
          )[0],
        ).id;
      kg = await idOf('KG');
      const packaging = (code: string) => ({
        ...emptyUnitDraft(),
        kind: 'packaging',
        code: `${tag}${code}`,
        name: `${code} ${tag}`,
        decimals: '0',
      });
      crate = (await k.c.unitWriter.create(packaging('CR'))).id;
      sack = (await k.c.unitWriter.create(packaging('SK'))).id;
      const itemTypeId = `it_cru_${tag}`;
      await k.db
        .insert(k.schema.itemTypes)
        .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
      fishId = (
        await CatalogService.createProduct(
          product({
            itemTypeId,
            baseUnitId: kg,
            packagings: [
              {
                unitId: crate,
                qtyPerBase: '20',
                weightKg: '',
                isSalesDefault: false,
                isPurchaseDefault: false,
              },
            ],
          }),
        )
      ).id;
    });

    /** An invoiced order of fish: each item is { kg, unit? } where a unit line is typed in crates. */
    async function sold(items: { quantity: number; crates?: number }[]) {
      seq += 1;
      const id = `cru_${tag}_${seq}`;
      const total = items.reduce((n, i) => n + i.quantity * 300, 0);
      await k.db
        .execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method)
      VALUES (${id}, ${`CRUO-${tag}-${seq}`}, 'u', ${k.branchId}::uuid, 'n', 'e@x.io', '1', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, ${total}, 0, 0, ${total}, 'mpesa_daraja')`);
      for (const item of items) {
        await k.db.insert(k.schema.orderItems).values({
          orderId: id,
          productId: fishId,
          productName: 'Fish',
          sku: 'F',
          quantity: item.quantity,
          unitPrice: '300.00',
          totalPrice: (item.quantity * 300).toFixed(2),
          imageUrl: '',
          unitCost: '200.0000',
          ...(item.crates === undefined
            ? {}
            : {
                unitId: crate,
                unitCode: `${tag}CR`,
                enteredQuantity: item.crates,
                qtyPerUnit: '20.0000000000',
                enteredUnitPrice: '6000.0000',
              }),
        });
      }
      await k.db
        .insert(k.schema.inventoryMovements)
        .values({
          id: `mv_${randomUUID()}`,
          productId: fishId,
          productName: 'Fish',
          changeAmount: 0,
          previousStock: 10,
          newStock: 10,
          changeType: 'order_fulfillment',
          referenceId: id,
        });
      await k.db
        .insert(k.schema.invoiceDocuments)
        .values({
          orderId: id,
          orderNumber: `CRUO-${tag}-${seq}`,
          invoiceNumber: `CRUI-${tag}-${seq}`,
          documentType: 'tax_invoice',
          customerEmail: 'e@x.io',
          customerName: 'n',
          currency: 'KES',
          subtotal: String(total),
          tax: '0',
          shippingFee: '0',
          totalAmount: String(total),
          pdfStorageKey: 'x.pdf',
          emailStatus: 'not_sent',
          meta: {},
        });
      return id;
    }
    const credit = (
      orderId: string,
      lines: { quantity: number; unitId?: string }[],
      restock = false,
    ) =>
      k.c.creditNotes.issueForOrder({
        orderId,
        lines: lines.map((l) => ({ productId: fishId, ...l })),
        reason: { code: 'returned_goods' },
        issuedBy: 'tester',
        restock,
      });
    const stock = async () =>
      required(
        (await k.db.select().from(k.schema.products).where(eq(k.schema.products.id, fishId)))[0],
      ).stockQuantity;

    it('offers the unit the goods were sold in, with what is left in kilograms', async () => {
      const orderId = await sold([{ quantity: 60, crates: 3 }]);
      const view = await k.c.creditNotes.creditableForOrder(orderId);
      expect(view.lines).toHaveLength(1);
      expect(view.lines[0]).toMatchObject({
        soldQuantity: 60,
        remainingQuantity: 60,
        remainingAmount: 18000,
        baseUnitName: 'Kilogram',
        baseDecimals: 3,
      });
      expect(view.lines[0]?.unit).toMatchObject({ code: `${tag}CR`, qtyPerUnit: '20' });
    });

    it('credits a crate and a half: 30 kg, priced per kilogram, remembered as the crates typed', async () => {
      const orderId = await sold([{ quantity: 60, crates: 3 }]);
      const note = await credit(orderId, [{ quantity: 1.5, unitId: crate }]);
      const [line] = await k.db
        .select()
        .from(k.schema.creditNoteLines)
        .where(eq(k.schema.creditNoteLines.creditNoteId, note.id));
      expect(line).toMatchObject({
        quantity: 30,
        enteredQuantity: 1.5,
        unitId: crate,
        unitCode: `${tag}CR`,
        amount: '9000.00',
      });
      expect(Number(line?.qtyPerUnit)).toBe(20);
      expect(Number(note.totalAmount)).toBe(9000);
      const left = (await k.c.creditNotes.creditableForOrder(orderId)).lines[0];
      expect(left).toMatchObject({
        creditedQuantity: 30,
        remainingQuantity: 30,
        remainingAmount: 9000,
      });
    });

    it('credits in kilograms too, and the last of it takes what is left', async () => {
      const orderId = await sold([{ quantity: 60, crates: 3 }]);
      await credit(orderId, [{ quantity: 12.5 }]);
      const last = await credit(orderId, [{ quantity: 2.35, unitId: crate }]);
      // 12.5 kg + 47 kg is all but 0.5 kg; asking for 2.35 crates would be 47 kg
      expect(Number(last.totalAmount)).toBe(14100);
      const final = await credit(orderId, [{ quantity: 0.5 }]);
      expect(Number(final.totalAmount)).toBe(150);
      expect((await k.c.creditNotes.creditableForOrder(orderId)).lines[0]?.remainingAmount).toBe(0);
    });

    it('refuses more than was sold, a unit it was not sold in, and a part unit the unit cannot hold', async () => {
      const orderId = await sold([{ quantity: 60, crates: 3 }]);
      await expect(credit(orderId, [{ quantity: 3.5, unitId: crate }])).rejects.toThrow(
        /cannot credit 70 more/,
      );
      await expect(credit(orderId, [{ quantity: 1, unitId: sack }])).rejects.toThrow(
        /was sold in .*CR/,
      );
      await expect(credit(orderId, [{ quantity: 0.0004 }])).rejects.toThrow(/at most 3 decimals/);
      await expect(credit(orderId, [{ quantity: 1.0004, unitId: crate }])).rejects.toThrow(
        /at most 3 decimals/,
      );
    });

    it('adds the lines of one product up: kilograms and crates on one order are one line to credit, in kilograms', async () => {
      const orderId = await sold([{ quantity: 10 }, { quantity: 20, crates: 1 }]);
      const view = (await k.c.creditNotes.creditableForOrder(orderId)).lines;
      expect(view).toHaveLength(1);
      expect(view[0]).toMatchObject({ soldQuantity: 30, remainingAmount: 9000, unit: null });
      const note = await credit(orderId, [{ quantity: 25.5 }]);
      expect(Number(note.totalAmount)).toBe(7650);
      await expect(credit(orderId, [{ quantity: 1, unitId: crate }])).rejects.toThrow(
        /not sold in another unit/,
      );
    });

    it('asks for the goods back in the same unit, and takes them in that unit into stock', async () => {
      const orderId = await sold([{ quantity: 60, crates: 3 }]);
      const note = await credit(orderId, [{ quantity: 1, unitId: crate }], true);
      const receipt = required(
        await k.c.returns.forCreditNotes([note.id]).then((m) => m.get(note.id)),
      );
      const detail = required(await k.c.returns.detail(k.companyId, receipt.id));
      const line = required(detail.lines[0]);
      expect(line).toMatchObject({ expectedQty: 20, unitId: crate, unitCode: `${tag}CR` });
      const before = await stock();
      const actor = {
        companyId: k.companyId,
        actorId: 'tester',
        origin: { surface: 'test', action: 'run' },
      };
      const good = { condition: 'good' as const, disposition: 'return_to_stock' as const };
      // 0.5 crate is 10 kg
      const first = await k.c.returns.confirm(actor, receipt.id, [
        { lineId: line.id, quantity: 0.5, unitId: crate, ...good },
      ]);
      expect(first).toEqual({ status: 'partially_confirmed', stockAdded: 10 });
      expect(await stock()).toBe(before + 10);
      // 10 kg are still expected; asking for a whole crate is too much, and so is a unit that is not the line's
      await expect(
        k.c.returns.confirm(actor, receipt.id, [
          { lineId: line.id, quantity: 1, unitId: crate, ...good },
        ]),
      ).rejects.toThrow(/still expected/);
      await expect(
        k.c.returns.confirm(actor, receipt.id, [
          { lineId: line.id, quantity: 1, unitId: sack, ...good },
        ]),
      ).rejects.toThrow(/count it in/);
      const rest = await k.c.returns.confirm(actor, receipt.id, [
        { lineId: line.id, quantity: 10, ...good },
      ]);
      expect(rest.status).toBe('confirmed');
      expect(await stock()).toBe(before + 20);
    });

    it('closing a return that has received a part of a unit keeps it partly received, not rejected', async () => {
      const orderId = await sold([{ quantity: 60, crates: 3 }]);
      const note = await credit(orderId, [{ quantity: 1, unitId: crate }], true);
      const receipt = required(
        await k.c.returns.forCreditNotes([note.id]).then((m) => m.get(note.id)),
      );
      const line = required((await k.c.returns.detail(k.companyId, receipt.id))?.lines[0]);
      const actor = {
        companyId: k.companyId,
        actorId: 'tester',
        origin: { surface: 'test', action: 'run' },
      };
      await k.c.returns.confirm(actor, receipt.id, [
        { lineId: line.id, quantity: 0.4, condition: 'good', disposition: 'quarantine' },
      ]);
      await k.c.returns.close(actor, receipt.id, { code: 'CUSTOMER_REQUEST' });
      expect(required((await k.c.returns.detail(k.companyId, receipt.id))?.r).status).toBe(
        'partially_confirmed',
      );
    });

    it('counts as use of the unit, so it cannot be deleted while a credit note or a return uses it', async () => {
      const usage = required((await k.c.units.usageOf([crate]))[crate]);
      expect(usage.documentLines).toBeGreaterThan(0);
      await expect(k.c.unitWriter.remove(crate)).rejects.toThrow(/document lines?/);
    });
  },
);
