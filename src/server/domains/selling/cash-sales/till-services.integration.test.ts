import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { parseCount } from '../shifts/shift-rules';

/**
 * The till screen's server side against a real database: the display setting, the tiles (by category, search and code; only what the
 * counter may sell; stock as it is), sales set aside and brought back once, and a shift that closes with nothing left on hold.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('the till screen (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  const actor = { type: 'user' as const, id: 'till-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const tag = randomUUID().slice(0, 6).toUpperCase();

  const user = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 8)}@till.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const shiftFor = async (person: { id: string }) => {
    const name = `Till ${randomUUID().slice(0, 6)}`;
    await c.shifts.saveRegister(companyId, actor, { branchId, name, isActive: true }, reason);
    const till = (await c.shifts.registerList(companyId)).find((r) => r.name === name);
    const float = parseCount({ total: 1000 }, 'cash');
    if (!float.ok) throw new Error(float.error);
    const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId: till?.id ?? '', float });
    if (!opened.ok) throw new Error(opened.error);
    return opened.shiftId;
  };
  const product = async (name: string, o: { categoryId?: string; stock?: number; offeredIn?: string[]; price?: string; sellable?: boolean; kind?: 'inventory' | 'service' } = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `TL-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `TLS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `${name} ${tag}`,
      slug: `tl-${randomUUID()}`,
      itemTypeId,
      price: o.price ?? '100',
      costPrice: '10',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: o.stock ?? 20,
      categoryId: o.categoryId ?? null,
      isActive: true,
      ...(o.offeredIn === undefined ? {} : { offeredIn: o.offeredIn }),
      ...(o.kind === undefined ? {} : { inventoryKind: o.kind }),
    });
    return id;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_tl_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Till Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
  });

  it('shows the counter inside the admin page until a company chooses the full-screen till, and refuses anything else', async () => {
    expect((await c.tillSettings.get(companyId)).tillMode).toBe('admin');
    await c.tillSettings.save(companyId, 'u1', 'fullscreen');
    expect((await c.tillSettings.get(companyId)).tillMode).toBe('fullscreen');
    await expect(c.tillSettings.save(companyId, 'u1', 'kiosk')).rejects.toThrow('Choose how the counter looks');
    expect((await c.tillSettings.get(companyId)).tillMode).toBe('fullscreen');
    await c.tillSettings.save(companyId, 'u1', 'admin');
    expect((await c.tillSettings.get(companyId)).tillMode).toBe('admin');
  });

  it('lists only what the counter may sell, by category, by search and by exact code, with stock as it is', async () => {
    const category = `cat_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.categories).values({ id: category, name: `Drinks ${tag}`, slug: `drinks-${category}` });
    const tea = await product('Tea', { categoryId: category, stock: 20 });
    const out = await product('Soda', { categoryId: category, stock: 0 });
    const hidden = await product('Hidden', { categoryId: category, offeredIn: ['quote'] });
    const service = await product('Haircut', { categoryId: category, kind: 'service', stock: 0 });
    await product('Other', { price: '50' });

    const list = await c.counterCatalogue.page({ categoryId: category, query: '', after: null });
    const byId = new Map(list.tiles.map((t) => [t.id, t]));
    expect(byId.has(hidden)).toBe(false);
    expect(byId.get(tea)?.inStock).toBe(20);
    expect(byId.get(out)?.inStock).toBe(0);
    expect(byId.get(service)?.inStock).toBeNull();
    expect(byId.get(tea)?.price).toBe(100);
    expect(list.tiles.every((t) => t.categoryId === category)).toBe(true);
    expect((await c.counterCatalogue.categories()).some((k) => k.id === category)).toBe(true);

    const found = await c.counterCatalogue.page({ categoryId: null, query: `Haircut ${tag}`, after: null });
    expect(found.tiles.map((t) => t.id)).toEqual([service]);
    const [row] = await db.select({ sku: schema.products.sku }).from(schema.products).where(eq(schema.products.id, tea));
    expect((await c.counterCatalogue.byCode(row?.sku.toLowerCase() ?? ''))?.id).toBe(tea);
    expect(await c.counterCatalogue.byCode('NO-SUCH-CODE')).toBeNull();
    // A search that has a wildcard in it is taken as plain text.
    expect((await c.counterCatalogue.page({ categoryId: null, query: '%', after: null })).tiles).toHaveLength(0);
  });

  it('pages by name without repeating or skipping a product', async () => {
    const category = `cat_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.categories).values({ id: category, name: `Paged ${tag}`, slug: `paged-${category}` });
    for (let n = 0; n < 30; n++) await product(`Item ${String(n).padStart(2, '0')}`, { categoryId: category });
    const seen: string[] = [];
    let after: { name: string; id: string } | null = null;
    do {
      const page: Awaited<ReturnType<typeof c.counterCatalogue.page>> = await c.counterCatalogue.page({ categoryId: category, query: '', after });
      seen.push(...page.tiles.map((t) => t.id));
      after = page.next;
    } while (after !== null);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it('sets a sale aside, lists it, and brings it back once; another person cannot', async () => {
    const person = await user('holder');
    const other = await user('other');
    await shiftFor(person);
    await shiftFor(other);
    const a = await product('Held A');
    const b = await product('Held B');
    const held = await c.heldSales.hold(companyId, person.id, { label: '', sale: { customerId: '', lines: [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }] } });
    expect(held.label).toBe('Sale 1');
    expect(held.lineCount).toBe(2);
    const listed = await c.heldSales.list(companyId, person.id);
    expect(listed.map((r) => r.id)).toEqual([held.id]);
    expect(listed[0]?.preview.join(' ')).toContain('Held A');
    expect(await c.heldSales.list(companyId, other.id)).toEqual([]);
    await expect(c.heldSales.recall(companyId, other.id, held.id)).rejects.toThrow('no longer on hold');

    const back = await c.heldSales.recall(companyId, person.id, held.id);
    expect(back.lines.map((l) => [l.productId, l.quantity])).toEqual([[a, 2], [b, 1]]);
    expect(back.lines[0]?.name).toContain('Held A');
    await expect(c.heldSales.recall(companyId, person.id, held.id)).rejects.toThrow('no longer on hold');
    expect(await c.heldSales.list(companyId, person.id)).toEqual([]);
  });

  it('refuses an empty or unreadable sale, a missing shift, and more than ten on hold; and gives one up', async () => {
    const person = await user('limits');
    const nobody = await user('noshift');
    const a = await product('Limit A');
    await expect(c.heldSales.hold(companyId, nobody.id, { label: 'x', sale: { lines: [{ productId: a, quantity: 1 }] } })).rejects.toThrow('no shift open');
    await shiftFor(person);
    await expect(c.heldSales.hold(companyId, person.id, { label: 'x', sale: { lines: [] } })).rejects.toThrow();
    await expect(c.heldSales.hold(companyId, person.id, { label: 'x', sale: 'nonsense' })).rejects.toThrow();
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) ids.push((await c.heldSales.hold(companyId, person.id, { label: `Hold ${String(n)}`, sale: { lines: [{ productId: a, quantity: 1 }] } })).id);
    await expect(c.heldSales.hold(companyId, person.id, { label: 'one too many', sale: { lines: [{ productId: a, quantity: 1 }] } })).rejects.toThrow('already have 10');
    await c.heldSales.discard(companyId, person.id, ids[0] ?? '');
    expect(await c.heldSales.list(companyId, person.id)).toHaveLength(9);
    await expect(c.heldSales.discard(companyId, person.id, ids[0] ?? '')).rejects.toThrow('no longer on hold');
  });

  it('is kept as put aside: the database refuses to change what was held, to bring a closed one back or to delete one', async () => {
    const person = await user('guard');
    await shiftFor(person);
    const a = await product('Guard A');
    const held = await c.heldSales.hold(companyId, person.id, { label: 'g', sale: { lines: [{ productId: a, quantity: 1 }] } });
    await expect(db.execute(sql`UPDATE held_sales SET payload = '{"lines":[]}'::jsonb WHERE id = ${held.id}`)).rejects.toThrow();
    await c.heldSales.discard(companyId, person.id, held.id);
    await expect(db.execute(sql`UPDATE held_sales SET status = 'held', resolved_at = NULL WHERE id = ${held.id}`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM held_sales WHERE id = ${held.id}`)).rejects.toThrow();
  });

  it('sells at a price typed at the till only within the price floors and the person\'s limit below list price', async () => {
    const person = await user('pricer');
    const item = await product('Priced', { price: '100' });
    const who = { userId: person.id, branchId };
    const priceAt = async (unitPrice: number) => await c.cashSales.price(companyId, who, { customerId: null, lines: [{ productId: item, quantity: 2, unitPrice }] });
    await db.insert(schema.priceOverrideLimits).values({ companyId, roleKey: 'manager', maxPercent: '10', createdBy: 'till-test' }).onConflictDoNothing();
    c.priceGuard.invalidate(companyId);
    try {
      const lower = await priceAt(95);
      expect(lower.ok && lower.lines[0]?.unitPrice).toBe(95);
      expect(lower.ok && lower.total).toBe(190);
      const higher = await priceAt(120);
      expect(higher.ok && higher.total).toBe(240);
      const tooLow = await priceAt(50);
      expect(tooLow.ok).toBe(false);
      expect(tooLow.ok ? '' : tooLow.error).toContain('lower than you may sell');
      const asListed = await c.cashSales.price(companyId, who, { customerId: null, lines: [{ productId: item, quantity: 2 }] });
      expect(asListed.ok && asListed.total).toBe(200);
    } finally {
      await db.delete(schema.priceOverrideLimits).where(eq(schema.priceOverrideLimits.roleKey, 'manager'));
    }
  });

  it('gives up whatever is still on hold when the shift closes', async () => {
    const person = await user('closer');
    const shiftId = await shiftFor(person);
    const a = await product('Close A');
    const held = await c.heldSales.hold(companyId, person.id, { label: 'left', sale: { lines: [{ productId: a, quantity: 1 }] } });
    const declared = parseCount({ total: 1000 }, 'cash');
    if (!declared.ok) throw new Error(declared.error);
    const closed = await c.shifts.close(companyId, { userId: person.id, supervisor: false }, shiftId, { declared, reason: '' });
    expect(closed.ok).toBe(true);
    const [row] = await db.select({ status: schema.heldSales.status }).from(schema.heldSales).where(eq(schema.heldSales.id, held.id));
    expect(row?.status).toBe('discarded');
  });
});
