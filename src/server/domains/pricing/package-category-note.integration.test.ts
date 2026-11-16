import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { OrderWriteService } from '@/server/domains/orders/write-service';
import type { SalesQuoteService } from '@/server/domains/quotes/service';
import { categoryOptionId } from './package-service';

/**
 * Category slots, the customer's note on a serving and order again, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('category slots, notes and order again (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let write: typeof OrderWriteService;
  let quotes: SalesQuoteService;
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;
  const actor = { type: 'user' as const, id: 'package-category-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const category = async (name = `Veg ${randomUUID().slice(0, 6)}`) => {
    const id = `cat_${randomUUID()}`;
    await db.insert(schema.categories).values({ id, name, slug: `cat-${randomUUID()}` });
    return id;
  };
  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `PC-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `PCS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Cat part ${randomUUID().slice(0, 4)}`,
      slug: `pc-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '10',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 50,
      ...over,
    });
    return id;
  };
  const customer = async () =>
    (await db.insert(schema.customers).values({ companyId, number: `PCC-${randomUUID().slice(0, 10)}`, name: 'Again Customer', email: `again-${randomUUID()}@pkg.test`, accountType: 'cash' }).returning())[0];

  /** A lunch with a fixed fish slot and a vegetable slot filled from a category (each pick adds 15). */
  const lunch = async (over: { allowNote?: boolean } = {}) => {
    const cat = await category('Greens');
    const p = {
      lunch: await product({ name: 'Cat lunch', price: '500', inventoryKind: 'non_inventory', stockQuantity: 0 }),
      fish: await product({ name: 'Cat fish', price: '200', stockQuantity: 100 }),
      sukuma: await product({ name: 'Cat sukuma', price: '40', categoryId: cat, categoryName: 'Greens', stockQuantity: 100 }),
      cabbage: await product({ name: 'Cat cabbage', price: '40', categoryId: cat, categoryName: 'Greens', stockQuantity: 100 }),
    };
    const save = (slots?: unknown[], extra: Record<string, unknown> = {}) =>
      c.packageConfig.save(
        companyId,
        {
          productId: p.lunch,
          pricingMode: 'base_plus_differences',
          allocation: 'list_price',
          shortStockMode: 'hide',
          ...(over.allowNote === undefined ? {} : { allowNote: over.allowNote }),
          slots: (slots ?? [
            { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.fish, quantity: 1 }] },
            { name: 'Vegetables', minPicks: 1, maxPicks: 2, source: 'category', categoryId: cat, categoryDifference: 15, categoryQuantity: 1, options: [] },
          ]) as never,
          ...extra,
        },
        actor,
        reason,
      );
    const view = await save();
    const pick = (slot: number, productId: string, count = 1) => {
      const s = view.slots[slot];
      if (s === undefined) throw new Error('slot missing');
      const option = s.options.find((o) => o.productId === productId);
      if (option === undefined) throw new Error('option missing');
      return { slotId: s.id, optionId: option.id, count };
    };
    return { p, cat, save, pick, view };
  };

  const order = async (productId: string, servings: number, picks: unknown[], note?: string, who?: { id: string }) => {
    const result = await write.createOrder({
      branchId,
      orderNumber: `PCO-${randomUUID()}`,
      customerName: 'Cat Buyer',
      customerEmail: `pco-${randomUUID()}@pkg.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: servings, package: { picks, ...(note === undefined ? {} : { note }) } }] as never,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      ...(who === undefined ? {} : { userId: who.id, customerId: who.id }),
    });
    return result;
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    write = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    quotes = new (await import('@/server/domains/quotes/service')).SalesQuoteService();
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pcn_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Category Note Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
  });

  describe('a slot filled from a category', () => {
    it('offers every product of the category that can be sold, and a new one appears by itself', async () => {
      const { p, cat } = await lunch();
      const first = await c.packageShop.builder(companyId, p.lunch);
      const veg = first?.package.slots[1];
      expect(veg?.options.map((o) => o.name).sort()).toEqual(['Cat cabbage', 'Cat sukuma']);
      expect(veg?.options.every((o) => o.id.startsWith('cat:') && o.difference === 15)).toBe(true);
      const spinach = await product({ name: 'Cat spinach', categoryId: cat, categoryName: 'Greens' });
      const second = await c.packageShop.builder(companyId, p.lunch);
      expect(second?.package.slots[1]?.options.map((o) => o.productId)).toContain(spinach);
      // Not offered: a switched-off product, a service-free kit-like packaging product, the package itself.
      await product({ name: 'Cat off', categoryId: cat, categoryName: 'Greens', isActive: false });
      await product({ name: 'Cat bag', categoryId: cat, categoryName: 'Greens', isCheckoutPackaging: true, showOnWebShop: false });
      const third = await c.packageShop.builder(companyId, p.lunch);
      expect(third?.package.slots[1]?.options.map((o) => o.name)).not.toContain('Cat off');
      expect(third?.package.slots[1]?.options.map((o) => o.name)).not.toContain('Cat bag');
    });

    it('prices and orders the picks like any option: the base plus the difference, stock held for the product', async () => {
      const { p, view } = await lunch();
      const veg = view.slots[1];
      const sukuma = veg?.options.find((o) => o.productId === p.sukuma);
      const fish = view.slots[0]?.options[0];
      if (veg === undefined || sukuma === undefined || fish === undefined) throw new Error('setup');
      expect(sukuma.id).toBe(categoryOptionId(p.sukuma));
      const result = await order(p.lunch, 2, [{ slotId: view.slots[0]?.id, optionId: fish.id, count: 1 }, { slotId: veg.id, optionId: sukuma.id, count: 1 }]);
      expect(result.success).toBe(true);
      expect(result.order?.totalAmount).toBeCloseTo((500 + 15) * 2, 1);
      const [row] = await db.select().from(schema.products).where(eq(schema.products.id, p.sukuma));
      expect(Number(row?.reservedQuantity)).toBe(2);
    });

    it('refuses a product of another category as a choice', async () => {
      const { p, view } = await lunch();
      const other = await lunch();
      const fish = view.slots[0]?.options[0];
      const foreign = other.view.slots[1]?.options[0];
      if (fish === undefined || foreign === undefined) throw new Error('setup');
      const result = await order(p.lunch, 1, [{ slotId: view.slots[0]?.id, optionId: fish.id, count: 1 }, { slotId: view.slots[1]?.id, optionId: foreign.id, count: 1 }]);
      expect(result.success).toBe(false);
    });

    it('is refused on saving for an unknown category, an empty category, and shares you set', async () => {
      const { p, save } = await lunch();
      const slot = (over: Record<string, unknown>) => ({ name: 'Vegetables', minPicks: 1, maxPicks: 1, source: 'category', categoryId: 'nope', options: [], ...over });
      const fish = { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.fish, quantity: 1 }] };
      await expect(save([fish, slot({})])).rejects.toThrow(/does not exist/);
      const empty = await category('Nothing here');
      await expect(save([fish, slot({ categoryId: empty })])).rejects.toThrow(/no product that can be sold/);
      const real = await category('Some veg');
      await product({ categoryId: real, categoryName: 'Some veg' });
      const weighted = { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: p.fish, quantity: 1, weight: 1 }] };
      await expect(save([weighted, slot({ categoryId: real })], { allocation: 'explicit' })).rejects.toThrow(/cannot be used with a slot filled from a category/);
      await expect(save([fish, slot({ categoryId: real, categoryQuantity: 0 })])).rejects.toThrow(/above zero/);
    });

    it('shows a category slot as its setting, and the products it offers now, when the package is read', async () => {
      const { p, cat } = await lunch();
      const [view] = await c.packageConfig.list(companyId, p.lunch);
      expect(view?.slots[1]).toMatchObject({ source: 'category', categoryId: cat, categoryName: 'Greens', categoryDifference: 15 });
      expect(view?.slots[1]?.options).toHaveLength(2);
      expect(view?.from.price).toBe(515);
    });
  });

  describe('a note on a serving', () => {
    it('is refused where the package does not take one, and kept with the order where it does', async () => {
      const off = await lunch();
      const pickOf = (l: Awaited<ReturnType<typeof lunch>>) => [l.pick(0, l.p.fish), l.pick(1, l.p.sukuma)];
      const refused = await order(off.p.lunch, 1, pickOf(off), 'no pepper');
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('does not take a note');

      const on = await lunch({ allowNote: true });
      const placed = await order(on.p.lunch, 2, pickOf(on), '  no pepper please  ');
      expect(placed.success).toBe(true);
      const [instance] = await db.select().from(schema.packageInstances).where(eq(schema.packageInstances.documentId, placed.order?.id ?? ''));
      expect(instance?.note).toBe('no pepper please');
      // The sheet shows it, and selections with different notes are different selections.
      const sheet = await c.preparation.forDay(companyId, null, '2000-01-01');
      const mine = sheet.sheet.groups.flatMap((g) => g.packages).flatMap((x) => x.selections).find((s) => s.orderNumber === placed.order?.orderNumber);
      expect(mine?.note).toBe('no pepper please');
      const plain = await order(on.p.lunch, 1, pickOf(on));
      expect(plain.success).toBe(true);
      const [other] = await db.select().from(schema.packageInstances).where(eq(schema.packageInstances.documentId, plain.order?.id ?? ''));
      expect(other?.note).toBe('');
      expect(other?.selectionKey).not.toBe(instance?.selectionKey);
    });

    it('refuses a note that is too long', async () => {
      const on = await lunch({ allowNote: true });
      const result = await order(on.p.lunch, 1, [on.pick(0, on.p.fish), on.pick(1, on.p.sukuma)], 'x'.repeat(201));
      expect(result.success).toBe(false);
    });

    it('goes from a quote to the order it becomes', async () => {
      const on = await lunch({ allowNote: true });
      const author = (await db.insert(schema.users).values({ email: `pcn-${randomUUID()}@pkg.test`, passwordHash: 'x', name: 'Note Author', role: 'manager' }).returning())[0];
      if (author === undefined) throw new Error('no user');
      const stored = [{ slotName: 'Fish', productId: on.p.fish, name: 'Cat fish', count: 1 }, { slotName: 'Vegetables', productId: on.p.cabbage, name: 'Cat cabbage', count: 1 }];
      const q = await quotes.create(author.id, { customerId: null, customerName: 'Note Quote Buyer', customerEmail: `nq-${randomUUID()}@pkg.test`, currency: 'KES', paymentMethod: 'mpesa_daraja', discountPercent: 0, shippingFee: 0, sections: [], lines: [{ productId: on.p.lunch, quantity: 3, discountPercent: 0, priceMode: 'catalog', package: { picks: stored, note: 'no onions' } }] } as never);
      expect(q.lines[0]?.priceTrace?.quotedAsPackage?.note).toBe('no onions');
      await db.update(schema.salesQuotes).set({ status: 'accepted', deliveryAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' } }).where(eq(schema.salesQuotes.id, q.id));
      const made = await quotes.convertToOrder(author.id, q.id);
      if (made === null) throw new Error('not converted');
      const [instance] = await db.select().from(schema.packageInstances).where(eq(schema.packageInstances.documentId, made.id));
      expect(instance).toMatchObject({ note: 'no onions', servings: 3 });
    });
  });

  describe('order again', () => {
    it('gives a signed-in shopper their earlier selections, newest first and each once, and nobody else', async () => {
      const on = await lunch({ allowNote: true });
      const me = await customer();
      const you = await customer();
      if (me === undefined || you === undefined) throw new Error('no customer');
      await order(on.p.lunch, 2, [on.pick(0, on.p.fish), on.pick(1, on.p.sukuma)], 'no pepper', me);
      await order(on.p.lunch, 2, [on.pick(0, on.p.fish), on.pick(1, on.p.sukuma)], 'no pepper', me);
      await order(on.p.lunch, 1, [on.pick(0, on.p.fish), on.pick(1, on.p.cabbage)], undefined, me);
      const mine = await c.packageShop.previous(companyId, me.id, on.p.lunch);
      expect(mine.map((m) => [m.servings, m.note, m.replaced.length])).toEqual([[1, '', 0], [2, 'no pepper', 0]]);
      expect(mine[0]?.summary).toBe('Cat lunch: Cat fish and Cat cabbage');
      expect(mine[0]?.total).toBeCloseTo(515, 1);
      expect(await c.packageShop.previous(companyId, you.id, on.p.lunch)).toEqual([]);
      expect(await c.packageShop.previous(companyId, randomUUID(), on.p.lunch)).toEqual([]);
    });

    it('puts the nearest available option in place of a part that is sold out, and says so', async () => {
      const on = await lunch();
      const me = await customer();
      if (me === undefined) throw new Error('no customer');
      await order(on.p.lunch, 1, [on.pick(0, on.p.fish), on.pick(1, on.p.sukuma)], undefined, me);
      await db.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, on.p.sukuma));
      const [again] = await c.packageShop.previous(companyId, me.id, on.p.lunch);
      expect(again?.replaced).toEqual([{ was: 'Cat sukuma', now: 'Cat cabbage' }]);
      expect(again?.summary).toBe('Cat lunch: Cat fish and Cat cabbage');
    });

    it('leaves a selection out when nothing can stand in for what is gone', async () => {
      const on = await lunch();
      const me = await customer();
      if (me === undefined) throw new Error('no customer');
      await order(on.p.lunch, 1, [on.pick(0, on.p.fish), on.pick(1, on.p.sukuma)], undefined, me);
      await db.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, on.p.fish));
      expect(await c.packageShop.previous(companyId, me.id, on.p.lunch)).toEqual([]);
    });
  });
});
