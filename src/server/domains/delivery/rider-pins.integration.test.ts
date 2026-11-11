import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));

/**
 * Signing in to the rider app with a phone number and a PIN, against a real database: handing out a PIN, checking it, shutting a rider
 * out after wrong tries (also when the guesses come at the same moment), choosing one's own PIN, and the riders who must never sign in so.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('rider PINs (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let companyId: string;
  let spy: { mockRestore: () => void } | undefined;
  const madeUsers: string[] = [];
  const dispatcher = () => ({ companyId, userId: 'dispatcher-1' });
  /** A Kenyan mobile number no other test uses: 0711 plus six random digits. */
  const phone = () => `0711${String(Math.floor(100000 + Math.random() * 899999))}`;

  const kinds = async () => {
    const now = await c.deliveryRiders.settings(companyId);
    const r = await c.deliveryRiders.setKinds(dispatcher(), { allowStaff: true, allowSeparate: true, expectedVersion: now.version });
    if (!r.ok) throw new Error(r.message);
  };
  /** A rider with an account of their own, and their phone number as typed. */
  const own = async (number: string = phone()) => {
    const email = `pin-${randomUUID()}@riders.test`;
    const made = await c.deliveryRiders.createSeparate(dispatcher(), { name: 'Pin Rider', email, phone: number, password: 'First-pass-1234' });
    if (!made.ok) throw new Error(made.message);
    const [row] = await db.select().from(schema.deliveryRiders).where(eq(schema.deliveryRiders.id, made.data.id));
    madeUsers.push(row?.userId ?? '');
    return { id: made.data.id, userId: row?.userId ?? '', phone: number };
  };
  const given = async (r: { id: string }) => {
    const issued = await c.riderPins.issue(dispatcher(), r.id);
    if (!issued.ok) throw new Error(issued.message);
    return issued.data.pin;
  };
  const rowOf = async (riderId: string) => (await db.select().from(schema.riderPins).where(eq(schema.riderPins.riderId, riderId)))[0];
  const selfOf = async (userId: string) => {
    const s = await c.deliveryRiders.forUser(userId);
    if (s === null) throw new Error('not a rider');
    return s;
  };
  const wrongPin = (right: string) => (right === '482915' ? '907351' : '482915');

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Pins Test Co');
  }, 300_000);
  afterAll(() => {
    spy?.mockRestore();
  });
  beforeEach(async () => {
    requirePermission.mockReset().mockResolvedValue('dispatcher-1');
    await kinds();
  });
  afterEach(async () => {
    if (madeUsers.length > 0) await db.update(schema.deliveryRiders).set({ status: 'ended', statusReason: 'test over' }).where(inArray(schema.deliveryRiders.userId, madeUsers));
  });

  it('hands out a six-digit PIN once, keeps only a hash of it, and the rider must choose their own', async () => {
    const r = await own();
    const pin = await given(r);
    expect(pin).toMatch(/^\d{6}$/);
    const row = await rowOf(r.id);
    expect(row).toMatchObject({ mustChange: true, failedAttempts: 0, lockedUntil: null });
    expect(row?.pinHash).not.toContain(pin);
    expect(row?.pinHash.startsWith('$2')).toBe(true);
    expect(row?.phone).toMatch(/^2547\d{8}$|^2541\d{8}$/);
    const status = (await c.riderPins.statusFor(companyId, [r.id])).get(r.id);
    expect(status).toMatchObject({ temporary: true, locked: null, lastSignedInAt: null });
    // The PIN is not in the log either.
    const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, r.id));
    expect(JSON.stringify(log)).not.toContain(pin);
    expect(log.map((l) => l.action)).toContain('rider.pin_issued');
  });

  it('checks the number written any way, says only "wrong" to a wrong PIN or an unknown number, and records the sign-in', async () => {
    const digits = String(Math.floor(100000 + Math.random() * 899999));
    const r = await own(`0711 ${digits.slice(0, 3)} ${digits.slice(3)}`);
    const pin = await given(r);
    const national = `711${digits}`;
    for (const written of [`0${national}`, `+254${national}`, `254${national}`, national, ` 0711-${digits.slice(0, 3)}-${digits.slice(3)} `]) {
      expect(await c.riderPins.verify(written, pin)).toMatchObject({ ok: true, userId: r.userId, riderId: r.id, mustChange: true });
    }
    expect(await c.riderPins.verify(r.phone, wrongPin(pin))).toEqual({ ok: false, reason: 'wrong' });
    expect(await c.riderPins.verify('0799888777', pin)).toEqual({ ok: false, reason: 'wrong' });
    for (const bad of [null, '', '12345', '1234567', 'abcdef', 123456]) expect(await c.riderPins.verify(r.phone, bad)).toEqual({ ok: false, reason: 'wrong' });
    expect(await c.riderPins.verify('not a number', pin)).toEqual({ ok: false, reason: 'wrong' });
    expect((await rowOf(r.id))?.lastSignedInAt).not.toBeNull();
  });

  it('shuts a rider out after five wrong tries in a row, even for the right PIN, until the time passes or the office lets them try', async () => {
    const r = await own();
    const pin = await given(r);
    for (let i = 0; i < 4; i += 1) expect(await c.riderPins.verify(r.phone, wrongPin(pin))).toEqual({ ok: false, reason: 'wrong' });
    expect(await c.riderPins.verify(r.phone, wrongPin(pin))).toMatchObject({ ok: false, reason: 'locked', words: expect.stringMatching(/minutes?/) as string });
    expect(await c.riderPins.verify(r.phone, pin)).toMatchObject({ ok: false, reason: 'locked' });
    expect((await rowOf(r.id))?.failedAttempts).toBe(5);
    expect((await c.riderPins.statusFor(companyId, [r.id])).get(r.id)?.locked).not.toBeNull();
    const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, r.id));
    expect(log.map((l) => l.action)).toContain('rider.pin_locked');
    // The office lets them try again, and a right PIN clears the count.
    expect((await c.riderPins.unlock(dispatcher(), r.id)).ok).toBe(true);
    expect(await c.riderPins.verify(r.phone, wrongPin(pin))).toEqual({ ok: false, reason: 'wrong' });
    expect(await c.riderPins.verify(r.phone, pin)).toMatchObject({ ok: true });
    expect((await rowOf(r.id))?.failedAttempts).toBe(0);
    // Time passing also lets them try: the lock runs out.
    for (let i = 0; i < 5; i += 1) await c.riderPins.verify(r.phone, wrongPin(pin));
    await db.update(schema.riderPins).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(schema.riderPins.riderId, r.id));
    expect(await c.riderPins.verify(r.phone, pin)).toMatchObject({ ok: true });
  });

  it('counts guesses made at the same moment one after another, so a burst cannot get past the lock', async () => {
    const r = await own();
    const pin = await given(r);
    const burst = await Promise.all(Array.from({ length: 14 }, () => c.riderPins.verify(r.phone, wrongPin(pin))));
    expect(burst.filter((b) => !b.ok && b.reason === 'wrong')).toHaveLength(4);
    expect(burst.filter((b) => !b.ok && b.reason === 'locked')).toHaveLength(10);
    // Every wrong try was counted once: five, and the right PIN no longer gets in.
    expect((await rowOf(r.id))?.failedAttempts).toBe(5);
    expect(await c.riderPins.verify(r.phone, pin)).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('lets the rider choose their own PIN: the current one is needed, wrong ones are counted, weak ones refused, and the old PIN stops working', async () => {
    const r = await own();
    const pin = await given(r);
    const self = await selfOf(r.userId);
    const stamp = await c.riderPins.stampFor(r.userId);
    expect(stamp).not.toBeNull();
    expect(await c.riderPins.change(self, { current: wrongPin(pin), next: '482915', confirm: '482915' })).toMatchObject({ ok: false, message: 'Your current PIN is not right.' });
    expect((await rowOf(r.id))?.failedAttempts).toBe(1);
    expect(await c.riderPins.change(self, { current: pin, next: '482915', confirm: '482916' })).toMatchObject({ ok: false, message: 'The two new PINs are not the same.' });
    for (const weak of ['123456', '111111', '12345', 'abcdef']) expect(await c.riderPins.change(self, { current: pin, next: weak, confirm: weak })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.riderPins.change(self, { current: pin, next: pin, confirm: pin })).toMatchObject({ ok: false, message: 'Choose a PIN different from the one you have now.' });
    const mine = pin === '907351' ? '135790' : '907351';
    const done = await c.riderPins.change(self, { current: pin, next: mine, confirm: mine });
    expect(done).toMatchObject({ ok: true });
    expect(await rowOf(r.id)).toMatchObject({ mustChange: false, failedAttempts: 0 });
    expect(await c.riderPins.verify(r.phone, pin)).toEqual({ ok: false, reason: 'wrong' });
    expect(await c.riderPins.verify(r.phone, mine)).toMatchObject({ ok: true, mustChange: false });
    // A session made with the old PIN ends: the stamp it carried is no longer the PIN's.
    expect(await c.riderPins.stampFor(r.userId)).not.toBe(stamp);
  });

  it('ends sessions made with an old PIN when the office gives a new one or turns it off', async () => {
    const r = await own();
    await given(r);
    const first = await c.riderPins.stampFor(r.userId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await given(r);
    const second = await c.riderPins.stampFor(r.userId);
    expect(second).not.toBe(first);
    expect((await c.riderPins.remove(dispatcher(), r.id)).ok).toBe(true);
    expect(await c.riderPins.stampFor(r.userId)).toBeNull();
    expect(await c.riderPins.remove(dispatcher(), r.id)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.riderPins.verify(r.phone, '482915')).toEqual({ ok: false, reason: 'wrong' });
  });

  it('is only for riders with an account of their own, with a Kenyan number nobody else signs in with, in this company', async () => {
    const staffUser = randomUUID();
    await db.insert(schema.users).values({ id: staffUser, email: `staff-${staffUser}@riders.test`, passwordHash: 'x', name: 'Staff Rider', role: 'super_admin', phone: '0711000222' });
    madeUsers.push(staffUser);
    const staff = await c.deliveryRiders.addStaff(dispatcher(), { userId: staffUser, phone: '0711000222' });
    expect(staff.ok).toBe(true);
    expect(await c.riderPins.issue(dispatcher(), staff.ok ? staff.data.id : '')).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('member of staff') as string });
    const abroad = await own();
    await db.update(schema.deliveryRiders).set({ phone: '+256712345678' }).where(eq(schema.deliveryRiders.id, abroad.id));
    expect(await c.riderPins.issue(dispatcher(), abroad.id)).toMatchObject({ ok: false, reason: 'bad_input' });
    const number = phone();
    const a = await own(number);
    const b = await own(number);
    expect((await c.riderPins.issue(dispatcher(), a.id)).ok).toBe(true);
    expect(await c.riderPins.issue(dispatcher(), b.id)).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await c.riderPins.issue({ ...dispatcher(), companyId: randomUUID() }, a.id)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.riderPins.issue(dispatcher(), 'nope')).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.riderPins.unlock({ ...dispatcher(), companyId: randomUUID() }, a.id)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.riderPins.remove({ ...dispatcher(), companyId: randomUUID() }, a.id)).toMatchObject({ ok: false, reason: 'not_found' });
    expect((await c.riderPins.statusFor(randomUUID(), [a.id])).size).toBe(0);
  });

  it('does not let a rider who is paused, has left, or whose account was switched off sign in, even with the right PIN, and does not count it against them', async () => {
    const r = await own();
    const pin = await given(r);
    expect(await c.riderPins.verify(r.phone, pin)).toMatchObject({ ok: true });
    await db.update(schema.deliveryRiders).set({ status: 'paused', statusReason: 'test' }).where(eq(schema.deliveryRiders.id, r.id));
    expect(await c.riderPins.verify(r.phone, pin)).toEqual({ ok: false, reason: 'wrong' });
    await db.update(schema.deliveryRiders).set({ status: 'active', statusReason: null }).where(eq(schema.deliveryRiders.id, r.id));
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, r.userId));
    expect(await c.riderPins.verify(r.phone, pin)).toEqual({ ok: false, reason: 'wrong' });
    await db.update(schema.users).set({ isActive: true, role: 'customer' }).where(eq(schema.users.id, r.userId));
    expect(await c.riderPins.verify(r.phone, pin)).toEqual({ ok: false, reason: 'wrong' });
    expect((await rowOf(r.id))?.failedAttempts).toBe(0);
    await db.update(schema.users).set({ role: 'rider' }).where(eq(schema.users.id, r.userId));
    expect(await c.riderPins.verify(r.phone, pin)).toMatchObject({ ok: true });
    // A rider who has left cannot sign in.
    await db.update(schema.deliveryRiders).set({ status: 'ended', statusReason: 'test' }).where(eq(schema.deliveryRiders.id, r.id));
    expect(await c.riderPins.verify(r.phone, pin)).toEqual({ ok: false, reason: 'wrong' });
  });

  it('turns the PIN off when the rider\'s phone number changes, so a new one is given for the new number', async () => {
    const r = await own();
    await given(r);
    const now = await c.deliveryRiders.get(companyId, r.id);
    const moved = await c.deliveryRiders.update(dispatcher(), r.id, { phone: phone(), expectedVersion: now?.version });
    expect(moved.ok).toBe(true);
    expect(await rowOf(r.id)).toBeUndefined();
    const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, r.id));
    expect(log.map((l) => l.action)).toContain('rider.pin_removed');
  });

  it('frees the number when the rider leaves, so whoever has it next can be given a PIN', async () => {
    const number = phone();
    const first = await own(number);
    await given(first);
    const row = await c.deliveryRiders.get(companyId, first.id);
    expect((await c.deliveryRiders.change(dispatcher(), first.id, { change: 'end', reason: 'Left the company', expectedVersion: row?.version })).ok).toBe(true);
    expect(await rowOf(first.id)).toBeUndefined();
    expect(await c.riderPins.verify(number, '482915')).toEqual({ ok: false, reason: 'wrong' });
    const next = await own(number);
    expect((await c.riderPins.issue(dispatcher(), next.id)).ok).toBe(true);
  });

  it('is shown to the office with the number, whether it is still temporary, and when the rider last signed in, never the PIN', async () => {
    const digits = String(Math.floor(100000 + Math.random() * 899999));
    const r = await own(`0711 ${digits.slice(0, 3)} ${digits.slice(3)}`);
    await given(r);
    const status = (await c.riderPins.statusFor(companyId, [r.id])).get(r.id);
    expect(status).toMatchObject({ phone: `254711${digits}`, phoneWords: `0711 ${digits.slice(0, 3)} ${digits.slice(3)}`, temporary: true });
    expect(JSON.stringify(status)).not.toMatch(/pin_?hash|\$2/);
    const { ridersPageAction } = await import('./rider-actions');
    const page = await ridersPageAction({});
    expect(page.ok && page.data.rows.find((x) => x.id === r.id)?.pin).toMatchObject({ phoneWords: `0711 ${digits.slice(0, 3)} ${digits.slice(3)}` });
  });
});
