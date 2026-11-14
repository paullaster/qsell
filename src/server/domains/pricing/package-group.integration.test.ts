import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { OrderWriteService } from '@/server/domains/orders/write-service';
import { MAX_OPEN_GROUPS } from './package-group-service';

/**
 * Group orders against a real database: an organiser shares a link, each person chooses their own serving, the organiser puts
 * everyone's choices in the cart and pays once. The link and each person's secret are kept only as hashes.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('group orders (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let write: typeof OrderWriteService;
  let companyId: string;
  let itemTypeId: string;
  let branchId: string;
  const actor = { type: 'user' as const, id: 'package-group-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `PG-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `PGS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: `Group part ${randomUUID().slice(0, 4)}`,
      slug: `pgr-${randomUUID()}`,
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

  const lunch = async () => {
    const p = {
      lunch: await product({ name: 'Group lunch', price: '500', inventoryKind: 'non_inventory', stockQuantity: 0 }),
      fish: await product({ name: 'Group fish', price: '200' }),
      beef: await product({ name: 'Group beef', price: '250' }),
      rice: await product({ name: 'Group rice', price: '50', stockQuantity: 3 }),
    };
    const save = (slots: unknown[]) =>
      c.packageConfig.save(companyId, { productId: p.lunch, pricingMode: 'base_plus_differences', allocation: 'list_price', shortStockMode: 'hide', allowNote: true, slots: slots as never }, actor, reason);
    const view = await save([
      { name: 'Main', minPicks: 1, maxPicks: 1, options: [{ productId: p.fish, quantity: 1 }, { productId: p.beef, quantity: 1, difference: 50 }] },
      { name: 'Side', minPicks: 1, maxPicks: 1, options: [{ productId: p.rice, quantity: 1 }] },
    ]);
    const pick = (slot: number, productId: string) => {
      const s = view.slots[slot];
      const o = s?.options.find((x) => x.productId === productId);
      if (s === undefined || o === undefined) throw new Error('option missing');
      return { slotId: s.id, optionId: o.id, count: 1 };
    };
    return { p, pick, save };
  };
  const customer = async () => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `PGC-${randomUUID().slice(0, 10)}`, name: 'Group Organiser', email: `go-${randomUUID()}@pkg.test`, accountType: 'cash' }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  const start = async (productId: string, who: { id: string; name: string }, over: Record<string, unknown> = {}) => {
    const made = await c.packageGroups.create(companyId, { customerId: who.id, name: who.name }, { productId, title: 'Friday team lunch', forDate: null, closesAt: null, ...over });
    if (!made.ok) throw new Error(made.error);
    return made;
  };
  const added = async (token: string, name: string, picks: unknown[], note = '') => {
    const r = await c.packageGroups.addEntry(token, { name, picks: picks as never, note });
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    write = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_pg_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Group Order Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
  });

  it('starts a group for a package, keeps only a hash of the link, and refuses what is not a package or a bad date or time', async () => {
    const { p } = await lunch();
    const me = await customer();
    const made = await start(p.lunch, me);
    expect(made.token).toHaveLength(32);
    const [row] = await db.select().from(schema.packageGroupOrders).where(eq(schema.packageGroupOrders.id, made.id));
    expect(row?.tokenHash).toHaveLength(64);
    expect(row?.tokenHash).not.toContain(made.token);
    expect(row).toMatchObject({ title: 'Friday team lunch', status: 'open', packageName: 'Group lunch' });
    expect(await c.packageGroups.create(companyId, { customerId: me.id, name: 'x' }, { productId: p.fish, title: '', forDate: null, closesAt: null })).toEqual({ ok: false, error: 'That is not a package that can be ordered.' });
    expect((await c.packageGroups.create(companyId, { customerId: me.id, name: 'x' }, { productId: p.lunch, title: '', forDate: '2026-02-30', closesAt: null })).ok).toBe(false);
    expect((await c.packageGroups.create(companyId, { customerId: me.id, name: 'x' }, { productId: p.lunch, title: '', forDate: null, closesAt: 'soon' })).ok).toBe(false);
    expect((await c.packageGroups.create(companyId, { customerId: me.id, name: 'x' }, { productId: p.lunch, title: '', forDate: null, closesAt: '2001-01-01T00:00:00Z' })).ok).toBe(false);
  });

  it('shows a person the group and the builder, and only the organiser who has chosen what', async () => {
    const { p, pick } = await lunch();
    const me = await customer();
    const { token } = await start(p.lunch, me);
    await added(token, 'Amina', [pick(0, p.fish), pick(1, p.rice)], 'no pepper');
    await added(token, 'Brian', [pick(0, p.beef), pick(1, p.rice)]);
    const guest = await c.packageGroups.view(token, null);
    expect(guest).toMatchObject({ accepts: true, isOrganiser: false, entryCount: 2, entries: [], packageName: 'Group lunch', title: 'Friday team lunch' });
    expect(guest?.builder?.package.slots).toHaveLength(2);
    const other = await c.packageGroups.view(token, (await customer()).id);
    expect(other?.entries).toEqual([]);
    const mine = await c.packageGroups.view(token, me.id);
    expect(mine?.isOrganiser).toBe(true);
    expect(mine?.entries.map((e) => [e.personName, e.words, e.note])).toEqual([['Amina', 'Group fish and Group rice', 'no pepper'], ['Brian', 'Group beef and Group rice', '']]);
    expect(await c.packageGroups.view('x'.repeat(32), null)).toBeNull();
  });

  it('checks a choice like an order would: a name, the choices, the note, and stock for a serving', async () => {
    const { p, pick } = await lunch();
    const me = await customer();
    const { token } = await start(p.lunch, me);
    expect((await c.packageGroups.addEntry(token, { name: '   ', picks: [pick(0, p.fish), pick(1, p.rice)], note: '' })).ok).toBe(false);
    expect((await c.packageGroups.addEntry(token, { name: 'Amina', picks: [pick(0, p.fish)], note: '' })).ok).toBe(false);
    expect((await c.packageGroups.addEntry(token, { name: 'Amina', picks: [pick(0, p.fish), pick(1, p.rice)], note: 'x'.repeat(201) })).ok).toBe(false);
    // Three rice in stock: the fourth person is told it is sold out.
    for (const n of ['A', 'B', 'C']) await added(token, n, [pick(0, p.fish), pick(1, p.rice)]);
    await db.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, p.rice));
    const late = await c.packageGroups.addEntry(token, { name: 'D', picks: [pick(0, p.fish), pick(1, p.rice)], note: '' });
    expect(late.ok).toBe(false);
  });

  it('stops taking choices when the organiser closes the group, when its time is over and when it is cancelled', async () => {
    const { p, pick } = await lunch();
    const me = await customer();
    const choice = [pick(0, p.fish), pick(1, p.rice)];
    const a = await start(p.lunch, me);
    expect((await c.packageGroups.setStatus(a.token, me.id, 'closed')).ok).toBe(true);
    const closed = await c.packageGroups.addEntry(a.token, { name: 'Amina', picks: choice, note: '' });
    expect(closed).toMatchObject({ ok: false });
    expect(!closed.ok && closed.error).toContain('organiser has stopped');
    expect((await c.packageGroups.view(a.token, null))?.accepts).toBe(false);
    expect((await c.packageGroups.setStatus(a.token, me.id, 'open')).ok).toBe(true);
    expect((await c.packageGroups.addEntry(a.token, { name: 'Amina', picks: choice, note: '' })).ok).toBe(true);

    const b = await start(p.lunch, me);
    await db.update(schema.packageGroupOrders).set({ closesAt: new Date(Date.now() - 1000) }).where(eq(schema.packageGroupOrders.id, b.id));
    const over = await c.packageGroups.addEntry(b.token, { name: 'Amina', picks: choice, note: '' });
    expect(!over.ok && over.error).toContain('time to choose is over');

    const cancelled = await start(p.lunch, me);
    await c.packageGroups.setStatus(cancelled.token, me.id, 'cancelled');
    expect((await c.packageGroups.addEntry(cancelled.token, { name: 'Amina', picks: choice, note: '' })).ok).toBe(false);
    expect(await c.packageGroups.setStatus(cancelled.token, me.id, 'open')).toEqual({ ok: false, error: 'A cancelled group order cannot be opened again.' });
    // Only the organiser changes the state.
    expect((await c.packageGroups.setStatus(a.token, (await customer()).id, 'closed')).ok).toBe(false);
  });

  it('lets a person change or withdraw only their own choice, by their secret, and the organiser remove any', async () => {
    const { p, pick } = await lunch();
    const me = await customer();
    const { token } = await start(p.lunch, me);
    const amina = await added(token, 'Amina', [pick(0, p.fish), pick(1, p.rice)]);
    const brian = await added(token, 'Brian', [pick(0, p.fish), pick(1, p.rice)]);
    const [stored] = await db.select().from(schema.packageGroupEntries).where(eq(schema.packageGroupEntries.id, amina.entryId));
    expect(stored?.secretHash).toHaveLength(64);
    expect(stored?.secretHash).not.toContain(amina.secret);
    // Her secret changes her choice; his secret, or none, does not.
    expect((await c.packageGroups.updateEntry(token, amina.entryId, amina.secret, { name: 'Amina K', picks: [pick(0, p.beef), pick(1, p.rice)], note: 'extra hot' })).ok).toBe(true);
    expect((await c.packageGroups.updateEntry(token, amina.entryId, brian.secret, { name: 'Amina K', picks: [pick(0, p.fish), pick(1, p.rice)], note: '' })).ok).toBe(false);
    expect((await c.packageGroups.updateEntry(token, amina.entryId, 'nope', { name: 'x', picks: [pick(0, p.fish), pick(1, p.rice)], note: '' })).ok).toBe(false);
    const view = await c.packageGroups.view(token, me.id);
    expect(view?.entries.find((e) => e.id === amina.entryId)).toMatchObject({ personName: 'Amina K', words: 'Group beef and Group rice', note: 'extra hot' });
    expect((await c.packageGroups.removeEntry(token, amina.entryId, { secret: brian.secret })).ok).toBe(false);
    expect((await c.packageGroups.removeEntry(token, amina.entryId, { secret: amina.secret })).ok).toBe(true);
    expect((await c.packageGroups.removeEntry(token, brian.entryId, { organiserCustomerId: (await customer()).id })).ok).toBe(false);
    expect((await c.packageGroups.removeEntry(token, brian.entryId, { organiserCustomerId: me.id })).ok).toBe(true);
    expect((await c.packageGroups.view(token, me.id))?.entryCount).toBe(0);
  });

  it('stops at a hundred people and at twenty open groups for one organiser', async () => {
    const { p, pick } = await lunch();
    const me = await customer();
    const { token, id } = await start(p.lunch, me);
    const first = await added(token, 'First', [pick(0, p.fish), pick(1, p.rice)]);
    const [one] = await db.select().from(schema.packageGroupEntries).where(eq(schema.packageGroupEntries.id, first.entryId));
    if (one === undefined) throw new Error('no entry');
    await db.insert(schema.packageGroupEntries).values(Array.from({ length: 98 }, (_, n) => ({ groupId: id, personName: `Person ${String(n)}`, picks: one.picks, selectionKey: one.selectionKey, secretHash: 'x'.repeat(64) })));
    expect((await c.packageGroups.addEntry(token, { name: 'Hundredth', picks: [pick(0, p.fish), pick(1, p.rice)], note: '' })).ok).toBe(true);
    const over = await c.packageGroups.addEntry(token, { name: 'Too many', picks: [pick(0, p.fish), pick(1, p.rice)], note: '' });
    expect(!over.ok && over.error).toContain('100 people');

    const busy = await customer();
    for (let n = 0; n < MAX_OPEN_GROUPS; n += 1) await start(p.lunch, busy);
    const more = await c.packageGroups.create(companyId, { customerId: busy.id, name: 'x' }, { productId: p.lunch, title: '', forDate: null, closesAt: null });
    expect(!more.ok && more.error).toContain('open group orders');
  });

  it('puts everyone\'s choices in the organiser\'s cart, identical ones joined, closes the group, and the order can be placed once', async () => {
    const { p, pick } = await lunch();
    const me = await customer();
    const { token } = await start(p.lunch, me);
    await added(token, 'Amina', [pick(0, p.fish), pick(1, p.rice)]);
    await added(token, 'Brian', [pick(0, p.beef), pick(1, p.rice)], 'no pepper');
    await added(token, 'Chao', [pick(0, p.fish), pick(1, p.rice)]);
    expect(await c.packageGroups.forCart(token, (await customer()).id)).toEqual({ ok: false, error: 'This group order is not yours.' });
    const result = await c.packageGroups.forCart(token, me.id);
    if (!result.ok) throw new Error(result.error);
    expect(result.cart.problems).toEqual([]);
    expect(result.cart.lines.map((l) => [l.servings, l.note, l.people])).toEqual([[2, '', ['Amina', 'Chao']], [1, 'no pepper', ['Brian']]]);
    expect((await c.packageGroups.view(token, me.id))?.status).toBe('closed');
    // The lines are ordinary package lines: one order for all three servings, paid once.
    const placed = await write.createOrder({
      branchId,
      userId: me.id,
      customerId: me.id,
      orderNumber: `PGO-${randomUUID()}`,
      customerName: 'Group Organiser',
      customerEmail: `go-${randomUUID()}@pkg.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: result.cart.lines.map((l) => ({ productId: p.lunch, quantity: l.servings, package: { picks: l.picks, ...(l.note === '' ? {} : { note: l.note }) } })),
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
    });
    expect(placed.success).toBe(true);
    // 2 x 500 + 1 x 550 = 1550 for all three, in one order.
    expect(placed.order?.totalAmount).toBeCloseTo(1550, 1);
    const instances = await db.select().from(schema.packageInstances).where(eq(schema.packageInstances.documentId, placed.order?.id ?? ''));
    expect(instances.map((i) => [i.servings, i.note]).sort()).toEqual([[1, 'no pepper'], [2, '']]);
  });

  it('names a person whose choice can no longer be made, rather than dropping it', async () => {
    const { p, pick, save } = await lunch();
    const me = await customer();
    const { token } = await start(p.lunch, me);
    await added(token, 'Amina', [pick(0, p.fish), pick(1, p.rice)]);
    await added(token, 'Brian', [pick(0, p.beef), pick(1, p.rice)]);
    await save([
      { name: 'Main', minPicks: 1, maxPicks: 1, options: [{ productId: p.fish, quantity: 1 }] },
      { name: 'Side', minPicks: 1, maxPicks: 1, options: [{ productId: p.rice, quantity: 1 }] },
    ]);
    const result = await c.packageGroups.forCart(token, me.id);
    if (!result.ok) throw new Error(result.error);
    expect(result.cart.lines.map((l) => l.people)).toEqual([['Amina']]);
    expect(result.cart.problems).toHaveLength(1);
    expect(result.cart.problems[0]).toMatchObject({ person: 'Brian' });
    expect(result.cart.problems[0]?.message).toContain('Group beef is no longer offered in Main');
    expect(await c.packageGroups.forCart('y'.repeat(32), me.id)).toEqual({ ok: false, error: 'This group order is not yours.' });
  });

  it('lists the organiser\'s own groups, newest first', async () => {
    const { p } = await lunch();
    const me = await customer();
    await start(p.lunch, me, { title: 'Monday' });
    await start(p.lunch, me, { title: 'Tuesday' });
    const mine = await c.packageGroups.mine(companyId, me.id);
    expect(mine.map((g) => g.title)).toEqual(['Tuesday', 'Monday']);
    expect(await c.packageGroups.mine(companyId, (await customer()).id)).toEqual([]);
  });
});
