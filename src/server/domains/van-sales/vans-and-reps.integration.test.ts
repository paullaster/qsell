import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import { parseCount } from '../selling/shifts/shift-rules';

/**
 * Vans and sales reps (database): a van is its stock location and its till made together; its stock is isolated from every other channel;
 * names, vehicles and people are held to one each; a van with stock or an open shift is not stopped; the generic Stock and Registers screens
 * cannot change a van's parts; reps are paused or ended with a reason, never deleted; the database refuses wrong values on its own.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('vans and sales reps (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let cashAccountId: string;
  let itemTypeId: string;
  const actor: Actor = { type: 'user', id: 'van-test' };
  const tag = randomUUID().slice(0, 6);
  let seq = 0;
  const name = (base: string) => `${base} ${tag}${String(++seq)}`;
  /** Products this file gave stock to by hand (no movement behind it): put back to nothing at the end, so the database the other suites share stays consistent. */
  const stocked: string[] = [];

  const van = (over: Record<string, unknown> = {}) => ({ name: name('Van'), branchId, vehicleId: null, cashAccountId, maxCash: 50_000, ...over });
  const vehicle = async () => {
    const r = await c.deliveryVehicles.create({ companyId, userId: actor.id ?? '' }, { name: name('KVEH') });
    if (!r.ok) throw new Error(r.message);
    return r.data.id;
  };
  const staff = async (role = 'super_admin', over: Partial<typeof schemaModule.users.$inferInsert> = {}) => {
    const [row] = await db.insert(schema.users).values({ email: `rep-${randomUUID().slice(0, 8)}@van.test`, passwordHash: 'x', name: name('Rep'), role, ...over }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const rep = (userId: string, over: Record<string, unknown> = {}) => ({ userId, phone: '+254 700 111 222', homeBranchId: branchId, modes: ['van_sell', 'pre_sell'], limits: { maxDiscountPercent: 5, maxCreditPerDay: 20_000, mayOverridePrice: false, maySellOnCredit: true }, ...over });
  /** The database's own words for what it refused. */
  const refusedBy = async (p: Promise<unknown>) => {
    const e = (await p.then(() => null, (err: unknown) => err)) as { message?: string; cause?: { message?: string } } | null;
    return e === null ? null : `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_van_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Van Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const [bank] = await db.insert(schema.bankAccounts).values({ companyId, code: `VAN${tag.toUpperCase()}`, name: `Van cash ${tag}`, kind: 'cash', currency: 'KES', createdBy: 'test' } as never).returning();
    cashAccountId = bank?.id ?? '';
  });

  afterAll(async () => {
    for (const id of stocked) {
      await db.update(schema.stockBalances).set({ onHand: 0, reserved: 0 }).where(eq(schema.stockBalances.productId, id));
      await db.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, id));
    }
  });

  describe('vans', () => {
    it('are made with their stock location and their till in one step, and the three are tied together', async () => {
      const input = van({ vehicleId: await vehicle() });
      const made = await c.vans.create(companyId, actor, input);
      expect(made).toMatchObject({ name: input.name, status: 'active', branchId, maxCash: 50_000, productsOnVan: 0, shiftOpen: false, cashAccountId });
      expect(made.locationCode).toMatch(/^VAN-/);
      const [location] = await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, made.locationId));
      expect(location).toMatchObject({ kind: 'van', branchId, name: input.name, isActive: true, isSellable: true, sellsChannels: ['van_sale'], fulfilsDelivery: false, allowNegative: false, isDefault: false });
      const [till] = await db.select().from(schema.registers).where(eq(schema.registers.id, made.registerId));
      expect(till).toMatchObject({ branchId, name: input.name, isActive: true, cashAccountId });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, made.id)).orderBy(schema.decisionLog.occurredAt);
      expect(log.map((l) => l.action)).toEqual(['van.created']);
    });

    it('hold stock that no shop, quote, order or counter channel can see or sell', async () => {
      const made = await c.vans.create(companyId, actor, van());
      const product = `prod_${randomUUID()}`;
      stocked.push(product);
      await db.insert(schema.products).values({ id: product, sku: `VS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `VSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Van tea ${tag}`, slug: `van-tea-${randomUUID().slice(0, 8)}`, itemTypeId, price: '100', costPrice: '50', stockQuantity: 5 });
      await db.insert(schema.stockBalances).values({ companyId, productId: product, locationId: made.locationId, onHand: 5, reserved: 0 });
      for (const channel of ['ecommerce', 'sales_order', 'credit_sale', 'pos_cash_sale', 'sales_invoice'] as const) {
        expect(await c.stockAvailability.forProduct(product, channel), channel).toEqual({ onHand: 0, reserved: 0, available: 0 });
      }
      expect(await c.stockAvailability.forProduct(product, 'van_sale' as never)).toEqual({ onHand: 5, reserved: 0, available: 5 });
      expect((await c.vans.get(companyId, made.id)).productsOnVan).toBe(1);
    });

    it('are refused a name already used (whatever its letter case), and a vehicle already behind another van in use', async () => {
      const first = await c.vans.create(companyId, actor, van({ vehicleId: await vehicle() }));
      await expect(c.vans.create(companyId, actor, van({ name: first.name.toUpperCase() }))).rejects.toThrow('already exists');
      await expect(c.vans.create(companyId, actor, van({ vehicleId: first.vehicleId }))).rejects.toThrow('already behind the van');
      // The failed attempts left no half-made van: no extra location or till carries that name.
      expect(await db.select().from(schema.stockLocations).where(sql`lower(${schema.stockLocations.name}) = ${first.name.toLowerCase()}`)).toHaveLength(1);
      expect(await db.select().from(schema.registers).where(sql`lower(${schema.registers.name}) = ${first.name.toLowerCase()}`)).toHaveLength(1);
    });

    it('are refused a branch, vehicle or cash account that is not the company\'s, and a wrongly written input, in words', async () => {
      await expect(c.vans.create(companyId, actor, van({ branchId: randomUUID() }))).rejects.toThrow('branches that is in use');
      await expect(c.vans.create(companyId, actor, van({ vehicleId: randomUUID() }))).rejects.toThrow('vehicles that is in use');
      await expect(c.vans.create(companyId, actor, van({ cashAccountId: randomUUID() }))).rejects.toThrow('cash accounts');
      await expect(c.vans.create(companyId, actor, van({ name: 'A' }))).rejects.toThrow('name of 2 to 60');
      await expect(c.vans.create(companyId, actor, van({ maxCash: -1 }))).rejects.toThrow('more than nothing');
    });

    it('are changed under a version: name, vehicle and cash limit follow into the location and the till; the branch stays', async () => {
      const made = await c.vans.create(companyId, actor, van());
      const renamed = name('Renamed van');
      const next = await c.vans.update(companyId, actor, made.id, van({ name: renamed, maxCash: 80_000, vehicleId: await vehicle() }), made.version);
      expect(next).toMatchObject({ name: renamed, maxCash: 80_000, version: made.version + 1 });
      expect((await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, made.locationId)))[0]?.name).toBe(renamed);
      expect((await db.select().from(schema.registers).where(eq(schema.registers.id, made.registerId)))[0]?.name).toBe(renamed);
      await expect(c.vans.update(companyId, actor, made.id, van({ name: renamed }), made.version)).rejects.toThrow('Someone else changed this van');
      const [other] = await db.insert(schema.branches).values({ companyId, name: name('Other branch'), code: `OB${tag}${String(seq)}`.toUpperCase().slice(0, 10) } as never).returning();
      await expect(c.vans.update(companyId, actor, made.id, van({ name: renamed, branchId: other?.id }), next.version)).rejects.toThrow('stays in its branch');
    });

    it('are stopped only when empty and with no shift open, with a reason, and stopping stops the location and the till too', async () => {
      const made = await c.vans.create(companyId, actor, van());
      await expect(c.vans.setActive(companyId, actor, made.id, { active: false, reason: '', expectedVersion: made.version })).rejects.toThrow('Say why');

      // Stock on the van keeps it going.
      const product = `prod_${randomUUID()}`;
      stocked.push(product);
      await db.insert(schema.products).values({ id: product, sku: `VT-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `VTS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Van item ${tag}`, slug: `van-item-${randomUUID().slice(0, 8)}`, itemTypeId, price: '10', costPrice: '5', stockQuantity: 2 });
      await db.insert(schema.stockBalances).values({ companyId, productId: product, locationId: made.locationId, onHand: 2, reserved: 0 });
      await expect(c.vans.setActive(companyId, actor, made.id, { active: false, reason: 'Sold the van', expectedVersion: made.version })).rejects.toThrow('still holds or has promised stock of 1 product');
      await db.update(schema.stockBalances).set({ onHand: 0 }).where(eq(schema.stockBalances.productId, product));
      await db.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, product));

      // A shift open on its till keeps it going.
      const person = await staff();
      const count = parseCount({ total: 0 }, 'cash');
      if (!count.ok) throw new Error(count.error);
      const opened = await c.shifts.open(companyId, { userId: person.id, branchId: null }, { registerId: made.registerId, float: count });
      if (!opened.ok) throw new Error(opened.error);
      expect((await c.vans.get(companyId, made.id)).shiftOpen).toBe(true);
      await expect(c.vans.setActive(companyId, actor, made.id, { active: false, reason: 'Sold the van', expectedVersion: made.version })).rejects.toThrow('shift open');
      await db.update(schema.shifts).set({ status: 'closed', closedAt: new Date(), closedBy: 'test', declaredCash: '0', zNumber: `Z-${tag}-${String(seq)}` }).where(eq(schema.shifts.id, opened.shiftId));

      const stopped = await c.vans.setActive(companyId, actor, made.id, { active: false, reason: 'Sold the van', expectedVersion: made.version });
      expect(stopped).toMatchObject({ status: 'stopped', statusReason: 'Sold the van', version: made.version + 1 });
      expect((await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, made.locationId)))[0]?.isActive).toBe(false);
      expect((await db.select().from(schema.registers).where(eq(schema.registers.id, made.registerId)))[0]?.isActive).toBe(false);
      await expect(c.vans.setActive(companyId, actor, made.id, { active: false, reason: 'Again', expectedVersion: stopped.version })).rejects.toThrow('already stopped');
      await expect(c.vans.update(companyId, actor, made.id, van({ name: made.name }), stopped.version)).rejects.toThrow('stopped');

      const back = await c.vans.setActive(companyId, actor, made.id, { active: true, expectedVersion: stopped.version });
      expect(back).toMatchObject({ status: 'active', statusReason: null });
      expect((await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, made.locationId)))[0]?.isActive).toBe(true);
      expect((await db.select().from(schema.registers).where(eq(schema.registers.id, made.registerId)))[0]?.isActive).toBe(true);
      const actions = (await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, made.id)).orderBy(schema.decisionLog.occurredAt)).map((l) => l.action);
      expect(actions).toEqual(['van.created', 'van.stopped', 'van.resumed']);
    });

    it('cannot be put back in use while its vehicle is now behind another van', async () => {
      const v = await vehicle();
      const a = await c.vans.create(companyId, actor, van({ vehicleId: v }));
      const stopped = await c.vans.setActive(companyId, actor, a.id, { active: false, reason: 'In the garage', expectedVersion: a.version });
      await c.vans.create(companyId, actor, van({ vehicleId: v }));
      await expect(c.vans.setActive(companyId, actor, a.id, { active: true, expectedVersion: stopped.version })).rejects.toThrow('already behind the van');
    });

    it('have a location and a till that the Stock and Registers screens cannot change', async () => {
      const made = await c.vans.create(companyId, actor, van());
      await expect(c.stockLocations.deactivate(companyId, made.locationId)).rejects.toThrow('Change, stop or use it again under Van sales');
      await expect(c.stockLocations.makeDefault(companyId, made.locationId)).rejects.toThrow('under Van sales');
      await expect(c.stockLocations.update(companyId, made.locationId, { code: made.locationCode, name: 'Hijacked', kind: 'van', branchId, sellsChannels: ['ecommerce'] })).rejects.toThrow('under Van sales');
      expect((await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, made.locationId)))[0]).toMatchObject({ name: made.name, sellsChannels: ['van_sale'] });
      await expect(c.shifts.saveRegister(companyId, actor, { id: made.registerId, branchId, name: made.name, isActive: false }, { code: 'POLICY_CHANGE' })).rejects.toThrow('belongs to the van');
      expect((await db.select().from(schema.registers).where(eq(schema.registers.id, made.registerId)))[0]?.isActive).toBe(true);
    });

    it('are listed a page at a time, by name, with a search and a status filter', async () => {
      const marker = name('Pagevan');
      for (let i = 0; i < 26; i += 1) await c.vans.create(companyId, actor, van({ name: `${marker} ${String(i).padStart(2, '0')}`, cashAccountId: null }));
      const first = await c.vans.page(companyId, { query: marker, status: 'all' });
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await c.vans.page(companyId, { query: marker, status: 'all', cursor: first.nextCursor });
      expect(second.rows).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const names = [...first.rows, ...second.rows].map((r) => r.name);
      expect(names).toEqual([...names].sort());
      expect(new Set(names).size).toBe(26);
      expect((await c.vans.page(companyId, { query: marker, status: 'stopped' })).rows).toHaveLength(0);
      const counts = await c.vans.counts(companyId);
      expect(counts.active).toBeGreaterThanOrEqual(26);
    });

    it('are held to their rules by the database itself', async () => {
      const made = await c.vans.create(companyId, actor, van());
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE vans SET ${set} WHERE id = '${made.id}'`)));
      expect(await bad("status = 'stopped'")).toContain('vans_stopped_reason_chk');
      expect(await bad("status = 'gone', status_reason = 'x'")).toContain('vans_status_chk');
      expect(await bad('max_cash = 0')).toContain('vans_max_cash_chk');
    });
  });

  describe('sales reps', () => {
    it('are made from a member of staff, with the modes they do and what they may do on their own', async () => {
      const person = await staff();
      const made = await c.salesReps.create(companyId, actor, rep(person.id, { modes: ['pre_sell'] }));
      expect(made).toMatchObject({ userId: person.id, name: person.name, email: person.email, phone: '+254 700 111 222', homeBranchId: branchId, modes: ['pre_sell'], maxDiscountPercent: 5, maxCreditPerDay: 20_000, mayOverridePrice: false, maySellOnCredit: true, status: 'active' });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, made.id)).orderBy(schema.decisionLog.occurredAt);
      expect(log.map((l) => l.action)).toEqual(['rep.created']);
    });

    it('are refused for a person who is not staff, not in use, already a rep, or not found, in words', async () => {
      const person = await staff();
      await c.salesReps.create(companyId, actor, rep(person.id));
      await expect(c.salesReps.create(companyId, actor, rep(person.id))).rejects.toThrow('already a sales rep');
      await expect(c.salesReps.create(companyId, actor, rep((await staff('customer')).id))).rejects.toThrow('member of staff whose account is in use');
      await expect(c.salesReps.create(companyId, actor, rep((await staff('super_admin', { isActive: false })).id))).rejects.toThrow('account is in use');
      await expect(c.salesReps.create(companyId, actor, rep((await staff('super_admin', { status: 'suspended' })).id))).rejects.toThrow('account is in use');
      await expect(c.salesReps.create(companyId, actor, rep(randomUUID()))).rejects.toThrow('account is in use');
      await expect(c.salesReps.create(companyId, actor, rep((await staff()).id, { homeBranchId: randomUUID() }))).rejects.toThrow('branches that is in use');
      await expect(c.salesReps.create(companyId, actor, rep((await staff()).id, { modes: [] }))).rejects.toThrow('what the rep does');
      await expect(c.salesReps.create(companyId, actor, rep((await staff()).id, { phone: 'call me' }))).rejects.toThrow('phone number');
    });

    it('are changed under a version, and their person never changes', async () => {
      const person = await staff();
      const made = await c.salesReps.create(companyId, actor, rep(person.id));
      const next = await c.salesReps.update(companyId, actor, made.id, { ...rep(person.id), userId: (await staff()).id, modes: ['van_sell'], limits: { maxDiscountPercent: 10, maxCreditPerDay: 0, mayOverridePrice: true, maySellOnCredit: false } }, made.version);
      expect(next).toMatchObject({ userId: person.id, modes: ['van_sell'], maxDiscountPercent: 10, mayOverridePrice: true, maySellOnCredit: false, version: made.version + 1 });
      await expect(c.salesReps.update(companyId, actor, made.id, rep(person.id), made.version)).rejects.toThrow('Someone else changed this sales rep');
    });

    it('are paused or ended with a reason, put back to work, and never deleted; an ended rep is not changed until back', async () => {
      const person = await staff();
      const made = await c.salesReps.create(companyId, actor, rep(person.id));
      await expect(c.salesReps.setStatus(companyId, actor, made.id, { status: 'paused', reason: '', expectedVersion: made.version })).rejects.toThrow('Say why');
      await expect(c.salesReps.setStatus(companyId, actor, made.id, { status: 'dancing', reason: 'x y z', expectedVersion: made.version })).rejects.toThrow('selling, paused or ended');
      await expect(c.salesReps.setStatus(companyId, actor, made.id, { status: 'active', expectedVersion: made.version })).rejects.toThrow('already selling');
      const paused = await c.salesReps.setStatus(companyId, actor, made.id, { status: 'paused', reason: 'On leave', expectedVersion: made.version });
      expect(paused).toMatchObject({ status: 'paused', statusReason: 'On leave' });
      const ended = await c.salesReps.setStatus(companyId, actor, made.id, { status: 'ended', reason: 'Left the company', expectedVersion: paused.version });
      expect(ended.status).toBe('ended');
      await expect(c.salesReps.update(companyId, actor, made.id, rep(person.id), ended.version)).rejects.toThrow('has ended');
      // Their account is switched off: they cannot be put back to work until it is on.
      await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, person.id));
      await expect(c.salesReps.setStatus(companyId, actor, made.id, { status: 'active', expectedVersion: ended.version })).rejects.toThrow('account is not in use');
      await db.update(schema.users).set({ isActive: true }).where(eq(schema.users.id, person.id));
      const back = await c.salesReps.setStatus(companyId, actor, made.id, { status: 'active', expectedVersion: ended.version });
      expect(back).toMatchObject({ status: 'active', statusReason: null });
      const actions = (await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, made.id)).orderBy(schema.decisionLog.occurredAt)).map((l) => l.action);
      expect(actions).toEqual(['rep.created', 'rep.paused', 'rep.ended', 'rep.resumed']);
    });

    it('are listed a page at a time with a search and a status filter, and counted', async () => {
      const person = await staff();
      const made = await c.salesReps.create(companyId, actor, rep(person.id));
      const found = await c.salesReps.page(companyId, { query: person.name, status: 'all' });
      expect(found.rows.map((r) => r.id)).toEqual([made.id]);
      expect((await c.salesReps.page(companyId, { query: person.email, status: 'active' })).rows).toHaveLength(1);
      expect((await c.salesReps.page(companyId, { query: person.name, status: 'ended' })).rows).toHaveLength(0);
      const counts = await c.salesReps.counts(companyId);
      expect(counts.active).toBeGreaterThanOrEqual(1);
    });

    it('are held to their rules by the database itself', async () => {
      const made = await c.salesReps.create(companyId, actor, rep((await staff()).id));
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE sales_reps SET ${set} WHERE id = '${made.id}'`)));
      expect(await bad("status = 'paused'")).toContain('sales_reps_reason_chk');
      expect(await bad("status = 'fired', status_reason = 'x'")).toContain('sales_reps_status_chk');
      expect(await bad("modes = ARRAY['driving']::text[]")).toContain('sales_reps_modes_chk');
      expect(await bad("modes = ARRAY[]::text[]")).toContain('sales_reps_modes_chk');
      expect(await bad('max_discount_percent = 101')).toContain('sales_reps_discount_chk');
      expect(await bad('max_credit_per_day = -1')).toContain('sales_reps_credit_chk');
    });
  });
});
