import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import { estimatedRoadKm } from '@/lib/geo';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as PolicyActions from './policy-actions';
import type * as Actions from './actions';
import { GeoService } from '@/server/domains/geo/service';
import { GeoPortRegistry } from '@/server/adapters/geo/registry';
import { BuiltinGeoAdapter } from '@/server/adapters/geo/builtin.adapter';
import type { GeoPort } from '@/server/ports/geo';
import { DeliveryQuotes } from './quote';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Charge policies against a real database: the draft, in force and retired life of a policy, what keeps a bad or tying policy from going
 * live, two people at once, and the quote from a branch to a customer end to end.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('delivery charge policies (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof PolicyActions;
  let zoneActions: typeof Actions;
  let companyId: string;
  let otherCompany: string;
  let spy: { mockRestore: () => void };
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const actor = { id: 'user-1' };
  let n = 0;
  const code = () => `CP${tag}${String((n += 1)).padStart(3, '0')}`;
  const madeZones: string[] = [];
  const madeBranches: string[] = [];

  const branch = async (pin: { latitude: number; longitude: number } | null = null, company = companyId) => {
    const [row] = await db.insert(schema.branches).values({ companyId: company, code: code(), name: `Branch ${code()}`, latitude: pin?.latitude ?? null, longitude: pin?.longitude ?? null }).returning();
    madeBranches.push(row?.id ?? '');
    return row?.id ?? '';
  };
  const zone = async (name = 'Zone', company = companyId) => {
    const [row] = await db.insert(schema.deliveryZones).values({ companyId: company, code: code(), name }).returning();
    madeZones.push(row?.id ?? '');
    return row?.id ?? '';
  };
  /** A flat policy that only applies to this branch, so tests do not meet each other's policies. */
  const flatInput = (branchId: string, over: Record<string, unknown> = {}) => ({ name: 'Flat', method: 'flat', currency: 'KES', priority: 0, scopes: { branch: { op: 'in', values: [branchId] } }, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 250 }], ...over });
  const draft = async (branchId: string, over: Record<string, unknown> = {}, policyCode = code()) => {
    const r = await actions.createChargePolicyDraftAction(policyCode, flatInput(branchId, over));
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const live = async (branchId: string, over: Record<string, unknown> = {}) => {
    const d = await draft(branchId, over);
    const r = await actions.activateChargePolicyAction(d.id, 'Set up for the test');
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const history = async (id: string) => (await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id)).orderBy(schema.decisionLog.occurredAt)).map((r) => [r.action, r.fromState, r.toState, r.reasonText]);
  const row = async (id: string) => (await db.select().from(schema.chargePolicies).where(eq(schema.chargePolicies.id, id)))[0];

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./policy-actions');
    zoneActions = await import('./actions');
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const o = await db.insert(schema.companySettings).values({ legalName: `Other ${tag}`, tradingName: `Other ${tag}`, email: `o-${tag}@example.test`, phone: '0', streetAddress: '1', city: 'N', countyOrState: 'N', postalCode: '0', kraPin: `P${tag}` }).returning();
    otherCompany = o[0]?.id ?? '';
  });
  afterAll(async () => {
    spy.mockRestore();
    const mine = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `CP${tag}%`));
    if (mine.length > 0) {
      await db.delete(schema.chargePolicyRates).where(inArray(schema.chargePolicyRates.policyId, mine.map((m) => m.id)));
      await db.delete(schema.chargePolicies).where(inArray(schema.chargePolicies.id, mine.map((m) => m.id)));
    }
    if (madeZones.length > 0) {
      await db.delete(schema.deliveryZoneAreas).where(inArray(schema.deliveryZoneAreas.zoneId, madeZones));
      await db.delete(schema.deliveryZones).where(inArray(schema.deliveryZones.id, madeZones));
    }
    if (madeBranches.length > 0) await db.delete(schema.branches).where(inArray(schema.branches.id, madeBranches));
    await db.delete(schema.companySettings).where(eq(schema.companySettings.id, otherCompany));
  });
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('user-1');
  });

  describe('a draft', () => {
    it('is made with a capital code, version 1, and a note in the decision log', async () => {
      const b = await branch();
      const made = await draft(b, {}, ` ${code().toLowerCase()} `);
      expect(made).toMatchObject({ version: 1, status: 'draft', revision: 1, method: 'flat', currency: 'KES' });
      expect(made.code).toBe(made.code.toUpperCase());
      expect(await history(made.id)).toEqual([['delivery.charge_policy_drafted', null, `${made.code} v1`, null]]);
      const full = await actions.getChargePolicyAction(made.id);
      expect(full).toMatchObject({ ok: true, data: { def: { rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 250, perExtraKg: 0 }] } } });
    });

    it('is refused when it is not sound, with the problems in words, and nothing is saved', async () => {
      const b = await branch();
      const bad = await actions.createChargePolicyDraftAction(code(), flatInput(b, { rates: [{ zoneId: null, fromKg: 0, toKg: 5, fee: 100 }, { zoneId: null, fromKg: 6, toKg: null, fee: 200 }], minCharge: 500, maxCharge: 400 }));
      expect(bad).toMatchObject({ ok: false, code: 'BAD_INPUT' });
      expect(!bad.ok && bad.error).toMatch(/This policy cannot be saved yet\. 1\./);
      expect(!bad.ok && bad.error).toMatch(/no fee covers 5 to 6 kg/);
      expect(!bad.ok && bad.error).toMatch(/minimum charge is above the maximum/);
      expect(await actions.createChargePolicyDraftAction('', flatInput(b))).toMatchObject({ ok: false });
      expect(await actions.createChargePolicyDraftAction('bad code!', flatInput(b))).toMatchObject({ ok: false, error: 'A code is up to 30 letters, numbers, dots, dashes or underscores.' });
      expect(await actions.createChargePolicyDraftAction(code(), { name: '' })).toMatchObject({ ok: false });
    });

    it('cannot reuse a code, and the words say to make a new version instead', async () => {
      const b = await branch();
      const first = await draft(b);
      const again = await actions.createChargePolicyDraftAction(first.code, flatInput(b));
      expect(again).toMatchObject({ ok: false, code: 'DUPLICATE' });
      expect(!again.ok && again.error).toMatch(/make a new version/);
    });

    it('may name only this company’s zones, branches and customer groups', async () => {
      const b = await branch();
      const ours = await zone();
      const foreignZone = await zone('Foreign', otherCompany);
      const rate = (zoneId: string) => ({ zoneId, fromKg: 0, toKg: null, fee: 100 });
      expect(await actions.createChargePolicyDraftAction(code(), flatInput(b, { method: 'zone_rate', rates: [rate(ours)] }))).toMatchObject({ ok: true });
      expect(await actions.createChargePolicyDraftAction(code(), flatInput(b, { method: 'zone_rate', rates: [rate(foreignZone)] }))).toMatchObject({ ok: false, error: 'A fee names a delivery zone that does not exist.' });
      expect(await actions.createChargePolicyDraftAction(code(), flatInput(b, { method: 'zone_rate', rates: [rate(randomUUID())] }))).toMatchObject({ ok: false });
      const foreignBranch = await branch(null, otherCompany);
      expect(await actions.createChargePolicyDraftAction(code(), flatInput(b, { scopes: { branch: { op: 'in', values: [foreignBranch] } } }))).toMatchObject({ ok: false, error: 'Who the policy is for names a branch that does not exist.' });
      expect(await actions.createChargePolicyDraftAction(code(), flatInput(b, { scopes: { customer_group: { op: 'in', values: [randomUUID()] } } }))).toMatchObject({ ok: false, error: 'Who the policy is for names a customer group that does not exist.' });
    });

    it('is changed, with its fees replaced, only if it is still the revision the person opened', async () => {
      const b = await branch();
      const d = await draft(b);
      const saved = await actions.saveChargePolicyDraftAction(d.id, flatInput(b, { name: 'Renamed', rates: [{ zoneId: null, fromKg: 0, toKg: 10, fee: 100 }, { zoneId: null, fromKg: 10, toKg: null, fee: 300 }] }), d.revision);
      expect(saved).toMatchObject({ ok: true, data: { name: 'Renamed', revision: 2 } });
      expect(await db.select().from(schema.chargePolicyRates).where(eq(schema.chargePolicyRates.policyId, d.id))).toHaveLength(2);
      const stale = await actions.saveChargePolicyDraftAction(d.id, flatInput(b, { name: 'Mine' }), d.revision);
      expect(stale).toEqual({ ok: false, error: 'Someone else changed this draft while you were editing. Reload it and make your change again.', code: 'CONFLICT' });
      expect((await row(d.id))?.name).toBe('Renamed');
      expect(await db.select().from(schema.chargePolicyRates).where(eq(schema.chargePolicyRates.policyId, d.id))).toHaveLength(2);
    });

    it('is changed by one of two people saving at once, and the other is told', async () => {
      const b = await branch();
      const d = await draft(b);
      const results = await Promise.all([actions.saveChargePolicyDraftAction(d.id, flatInput(b, { name: 'A' }), 1), actions.saveChargePolicyDraftAction(d.id, flatInput(b, { name: 'B' }), 1)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: 'CONFLICT' });
    });

    it('keeps an unsound change out: the draft stays as it was', async () => {
      const b = await branch();
      const d = await draft(b);
      expect(await actions.saveChargePolicyDraftAction(d.id, flatInput(b, { rates: [] }), d.revision)).toMatchObject({ ok: false, code: 'BAD_INPUT' });
      expect(await row(d.id)).toMatchObject({ revision: 1 });
      expect(await db.select().from(schema.chargePolicyRates).where(eq(schema.chargePolicyRates.policyId, d.id))).toHaveLength(1);
    });

    it('can be discarded; nothing else can', async () => {
      const b = await branch();
      const d = await draft(b);
      expect(await actions.deleteChargePolicyDraftAction(d.id)).toMatchObject({ ok: true });
      expect(await row(d.id)).toBeUndefined();
      const p = await live(b);
      expect(await actions.deleteChargePolicyDraftAction(p.id)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
      expect(await row(p.id)).toBeDefined();
    });
  });

  describe('going into force', () => {
    it('needs a reason, and then the policy is in force with who and when, and the log says why', async () => {
      const b = await branch();
      const d = await draft(b);
      expect(await actions.activateChargePolicyAction(d.id, '')).toMatchObject({ ok: false, error: 'Say why, in a few words, so the change can be explained later.' });
      expect(await actions.activateChargePolicyAction(d.id, 'ok')).toMatchObject({ ok: false });
      expect((await row(d.id))?.status).toBe('draft');
      expect(await actions.activateChargePolicyAction(d.id, 'New standard rate from today')).toMatchObject({ ok: true, data: { status: 'in_force' } });
      expect(await row(d.id)).toMatchObject({ status: 'in_force', activatedBy: 'user-1' });
      expect((await row(d.id))?.activatedAt).toBeInstanceOf(Date);
      expect((await history(d.id)).at(-1)).toEqual(['delivery.charge_policy_in_force', `${d.code} v1 draft`, `${d.code} v1 in force`, 'New standard rate from today']);
      expect(await actions.activateChargePolicyAction(d.id, 'again please')).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    });

    it('is refused when a zone it prices is stopped, naming the zone', async () => {
      const b = await branch();
      const z = await zone();
      const d = await draft(b, { method: 'zone_rate', rates: [{ zoneId: z, fromKg: 0, toKg: null, fee: 100 }] });
      await zoneActions.setDeliveryZoneActiveAction(z, false);
      const r = await actions.activateChargePolicyAction(d.id, 'Try it with a stopped zone');
      expect(r).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
      expect(!r.ok && r.error).toMatch(/is stopped\. Restart it or remove its fees/);
      expect((await row(d.id))?.status).toBe('draft');
    });

    it('is refused when it would tie with one already in force, naming it, and allowed once they differ', async () => {
      const b = await branch();
      const first = await live(b);
      const second = await draft(b, { name: 'Second' });
      const r = await actions.activateChargePolicyAction(second.id, 'A second standard rate');
      expect(r).toMatchObject({ ok: false, code: 'CONFLICT' });
      expect(!r.ok && r.error).toContain(`${first.code} (version 1) is in force with the same priority`);
      expect((await row(second.id))?.status).toBe('draft');
      await actions.saveChargePolicyDraftAction(second.id, flatInput(b, { name: 'Second', priority: 5 }), 1);
      expect(await actions.activateChargePolicyAction(second.id, 'Now it outranks the first')).toMatchObject({ ok: true });
      // A policy for a different branch never ties.
      const other = await branch();
      expect(await live(other)).toMatchObject({ status: 'in_force' });
    });

    it('replaces the version in force of the same policy in one step, never leaving two or none', async () => {
      const b = await branch();
      const v1 = await live(b);
      const v2 = await actions.newChargePolicyVersionAction(v1.id);
      expect(v2).toMatchObject({ ok: true, data: { code: v1.code, version: 2, status: 'draft' } });
      if (!v2.ok) return;
      await actions.saveChargePolicyDraftAction(v2.data.id, flatInput(b, { rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 300 }] }), v2.data.revision);
      expect(await actions.activateChargePolicyAction(v2.data.id, 'Delivery now costs 300')).toMatchObject({ ok: true });
      expect(await row(v1.id)).toMatchObject({ status: 'retired', retiredBy: 'user-1' });
      expect(await row(v2.data.id)).toMatchObject({ status: 'in_force' });
      const inForce = await c.chargePolicies.inForce(companyId);
      expect(inForce.filter((p) => p.row.code === v1.code).map((p) => p.row.version)).toEqual([2]);
      expect((await history(v1.id)).at(-1)).toEqual(['delivery.charge_policy_replaced', `${v1.code} v1 in force`, `${v1.code} v1 retired`, 'Delivery now costs 300']);
    });

    it('is put in force by one of two people at the same moment, and the other is told', async () => {
      const b = await branch();
      const d = await draft(b);
      const results = await Promise.all([actions.activateChargePolicyAction(d.id, 'First of two people'), actions.activateChargePolicyAction(d.id, 'Second of two people')]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: 'NOT_ALLOWED' });
    });

    it('cannot be edited once in force, and cannot be in force twice by the database’s own rule', async () => {
      const b = await branch();
      const p = await live(b);
      expect(await actions.saveChargePolicyDraftAction(p.id, flatInput(b, { name: 'Sneaky' }), p.revision)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
      expect((await row(p.id))?.name).toBe('Flat');
      const v2 = await actions.newChargePolicyVersionAction(p.id);
      expect(v2).toMatchObject({ ok: true });
      await expect(db.execute(sql`UPDATE charge_policies SET status = 'in_force' WHERE id = ${v2.ok ? v2.data.id : ''}`)).rejects.toThrow();
    });
  });

  describe('versions and retirement', () => {
    it('copy everything into a draft of the next version, only one draft at a time', async () => {
      const b = await branch();
      const z = await zone();
      const p = await live(b, { method: 'zone_rate', rates: [{ zoneId: z, fromKg: 0, toKg: 5, fee: 100 }, { zoneId: z, fromKg: 5, toKg: null, fee: 150, perExtraKg: 10 }], tiers: [{ minOrderValue: 3000, percentOff: 100 }], surcharges: [{ label: 'Weekend', kind: 'fixed', amount: 50, days: [0, 6] }], minCharge: 100, roundTo: 10 });
      const v2 = await actions.newChargePolicyVersionAction(p.id);
      expect(v2).toMatchObject({ ok: true, data: { version: 2, status: 'draft' } });
      if (!v2.ok) return;
      const copy = await actions.getChargePolicyAction(v2.data.id);
      const original = await actions.getChargePolicyAction(p.id);
      expect(copy.ok && original.ok && { ...copy.data.def, id: '', version: 0 }).toEqual(original.ok ? { ...original.data.def, id: '', version: 0 } : null);
      const again = await actions.newChargePolicyVersionAction(p.id);
      expect(again).toMatchObject({ ok: false, code: 'DUPLICATE', error: 'This policy already has a draft. Open it and change that instead.' });
      expect(await actions.newChargePolicyVersionAction(v2.data.id)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
      expect((await history(v2.data.id))[0]).toEqual(['delivery.charge_policy_versioned', `${p.code} v1`, `${p.code} v2`, null]);
    });

    it('retire a policy in force, with a reason, and a retired one can be versioned again', async () => {
      const b = await branch();
      const p = await live(b);
      expect(await actions.retireChargePolicyAction(p.id, '')).toMatchObject({ ok: false });
      expect(await actions.retireChargePolicyAction(p.id, 'We no longer deliver to this branch’s area')).toMatchObject({ ok: true, data: { status: 'retired' } });
      expect((await history(p.id)).at(-1)).toEqual(['delivery.charge_policy_retired', `${p.code} v1 in force`, `${p.code} v1 retired`, 'We no longer deliver to this branch’s area']);
      expect(await actions.retireChargePolicyAction(p.id, 'Again, for the record')).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
      expect(await actions.newChargePolicyVersionAction(p.id)).toMatchObject({ ok: true, data: { version: 2 } });
      expect((await c.chargePolicies.inForce(companyId)).some((x) => x.row.id === p.id)).toBe(false);
    });
  });

  describe('the list', () => {
    it('pages by code with a keyset and no repeats, and shows retired policies only on request', async () => {
      const b = await branch();
      const kept = await live(b);
      const gone = await live(await branch());
      await actions.retireChargePolicyAction(gone.id, 'Not needed any more');
      for (let i = 0; i < 26; i += 1) await db.insert(schema.chargePolicies).values({ companyId, code: `CP${tag}P${String(i).padStart(2, '0')}`, name: 'Paged', method: 'flat', currency: 'KES', createdBy: 'test' });
      const first = await actions.chargePoliciesPageAction({ query: `CP${tag}P` });
      expect(first.ok && first.data.rows).toHaveLength(25);
      const second = await actions.chargePoliciesPageAction({ query: `CP${tag}P`, cursor: first.ok ? first.data.nextCursor : null });
      expect(second.ok && second.data.rows).toHaveLength(1);
      const live1 = await actions.chargePoliciesPageAction({ query: tag });
      const ids = live1.ok ? live1.data.rows.map((r) => r.id) : [];
      expect(ids).toContain(kept.id);
      expect(ids).not.toContain(gone.id);
      const retired = await actions.chargePoliciesPageAction({ query: tag, status: 'retired' });
      expect(retired.ok && retired.data.rows.map((r) => r.id)).toContain(gone.id);
    });
  });

  describe('the quote', () => {
    // Nairobi CBD for the branch and a customer about 10 km away.
    const branchPin = { latitude: -1.2864, longitude: 36.8172 };
    const customerPin = { latitude: -1.2195, longitude: 36.8895 };
    const wednesday = new Date('2026-11-04T09:00:00Z');
    const quote = (branchId: string, over: Record<string, unknown> = {}) => actions.quoteDeliveryAction({ branchId, at: wednesday.toISOString(), weightKg: 2, orderValue: 1500, ...over });

    it('prices a flat fee from the policy that fits the branch, and shows how it chose', async () => {
      const b = await branch();
      const p = await live(b);
      const r = await quote(b);
      expect(r).toMatchObject({ ok: true, data: { ok: true, amount: 250, currency: 'KES', policy: { code: p.code, version: 1 }, zone: null, route: null } });
      expect(r.ok && r.data.ok && r.data.considered.find((x) => x.id === p.id)).toMatchObject({ outcome: 'won' });
    });

    it('prices by zone from a written address and from a pin in a coverage circle, the pin deciding', async () => {
      const b = await branch(branchPin);
      const written = await zone('By words');
      const circle = (await c.deliveryZones.create(companyId, actor, { code: code(), name: 'By circle', description: null, centre: customerPin, radiusKm: 3 })).id;
      madeZones.push(circle);
      await c.deliveryZones.addAreas(companyId, actor, written, [{ county: `Nairobi ${tag}`, town: 'Karen', area: null, countyKey: `nairobi ${tag.toLowerCase()}`, townKey: 'karen', areaKey: '' }]);
      await live(b, { method: 'zone_rate', rates: [{ zoneId: written, fromKg: 0, toKg: null, fee: 300 }, { zoneId: circle, fromKg: 0, toKg: null, fee: 450 }] });
      const byWords = await quote(b, { county: `Nairobi ${tag}`, town: 'Karen' });
      expect(byWords).toMatchObject({ ok: true, data: { ok: true, amount: 300, zone: { name: 'By words', by: 'address' } } });
      const byPin = await quote(b, { county: `Nairobi ${tag}`, town: 'Karen', latitude: customerPin.latitude, longitude: customerPin.longitude });
      expect(byPin).toMatchObject({ ok: true, data: { ok: true, amount: 450, zone: { name: 'By circle', by: 'pin' } } });
      expect(await quote(b, { county: 'Nowhere' })).toMatchObject({ ok: true, data: { ok: false, reason: 'no_zone' } });
    });

    it('prices by distance from the branch’s own pin to the customer’s pin, deterministically, with the map source on the trace', async () => {
      const b = await branch(branchPin);
      await live(b, { method: 'distance', rates: [], bands: [{ fromKm: 0, toKm: 5, baseFee: 150, perKm: 0 }, { fromKm: 5, toKm: null, baseFee: 150, perKm: 30 }], roundTo: 10, roundMode: 'up' });
      const km = estimatedRoadKm(branchPin, customerPin, 1.3);
      const expected = Math.ceil((150 + 30 * (km - 5)) / 10) * 10;
      const r1 = await quote(b, { latitude: customerPin.latitude, longitude: customerPin.longitude });
      const r2 = await quote(b, { latitude: customerPin.latitude, longitude: customerPin.longitude });
      expect(r1).toMatchObject({ ok: true, data: { ok: true, amount: expected, route: { km, provider: 'builtin', degraded: false, approximate: false } } });
      expect(r2).toEqual(r1);
    });

    it('says in words when it cannot: no pin on the branch, no pin from the customer, nothing in force, a stopped state of affairs', async () => {
      const noPin = await branch();
      await live(noPin, { method: 'distance', rates: [], bands: [{ fromKm: 0, toKm: null, baseFee: 100, perKm: 5 }] });
      expect(await quote(noPin, { latitude: 1, longitude: 1 })).toMatchObject({ ok: true, data: { ok: false, reason: 'branch_has_no_pin' } });
      const pinned = await branch(branchPin);
      await live(pinned, { method: 'distance', rates: [], bands: [{ fromKm: 0, toKm: null, baseFee: 100, perKm: 5 }] });
      const none = await quote(pinned, { county: 'Nairobi' });
      expect(none).toMatchObject({ ok: true, data: { ok: false, reason: 'no_distance' } });
      expect(none.ok && !none.data.ok && none.data.message).toMatch(/map pin or an address that can be found on the map/);
      const lonely = await branch(branchPin);
      expect(await quote(lonely)).toMatchObject({ ok: true, data: { ok: false, reason: 'no_policy' } });
      expect(await quote(randomUUID())).toMatchObject({ ok: true, data: { ok: false, reason: 'no_branch' } });
      expect(await quote('nope')).toMatchObject({ ok: false });
      expect(await quote(pinned, { latitude: 95, longitude: 1 })).toMatchObject({ ok: false, error: 'A latitude is between -90 and 90.' });
      expect(await quote(pinned, { at: 'someday' })).toMatchObject({ ok: false, error: 'The time is not valid.' });
    });

    it('uses the time of the order for time rules, in the business’s time zone', async () => {
      const b = await branch();
      await live(b, { surcharges: [{ label: 'Weekend', kind: 'fixed', amount: 50, days: [0, 6] }] });
      expect(await quote(b, { at: '2026-11-04T09:00:00Z' })).toMatchObject({ ok: true, data: { amount: 250 } });
      expect(await quote(b, { at: '2026-11-07T09:00:00Z' })).toMatchObject({ ok: true, data: { amount: 300 } });
    });

    it('places a written address on the map when the map service can, and says the distance is approximate; it falls back when the map is down', async () => {
      const b = await branch(branchPin);
      await live(b, { method: 'distance', rates: [], bands: [{ fromKm: 0, toKm: null, baseFee: 100, perKm: 10 }] });
      const builtin = new BuiltinGeoAdapter();
      const fakeProvider = (mode: 'works' | 'down'): GeoPort => ({
        provider: 'acme',
        capabilities: { ...builtin.capabilities, placeSearch: true },
        searchPlaces: () => (mode === 'works' ? Promise.resolve([{ id: 'x', label: 'Karen', secondary: null, point: customerPin }]) : Promise.reject(new Error('down'))),
        resolvePlace: () => Promise.resolve(null),
        reverse: () => Promise.resolve(null),
        distancesFrom: (from, to) => (mode === 'works' ? builtin.distancesFrom(from, to) : Promise.reject(new Error('down'))),
      });
      const withGeo = (mode: 'works' | 'down') => new DeliveryQuotes(db, c.chargePolicies, c.deliveryZones, new GeoService(new GeoPortRegistry({ GEO_DRIVER: 'acme' }, { builtin: () => builtin, acme: () => fakeProvider(mode) }), 200));
      const input = { branchId: b, at: wednesday, currency: 'KES', address: { county: 'Nairobi', town: 'Karen', area: null }, weightKg: 1, orderValue: 100 };
      const placed = await withGeo('works').quote(companyId, input);
      const km = estimatedRoadKm(branchPin, customerPin, 1.3);
      expect(placed).toMatchObject({ ok: true, amount: Math.round((100 + 10 * km) * 100) / 100, route: { approximate: true, provider: 'acme', degraded: false } });
      const down = await withGeo('down').quote(companyId, input);
      expect(down).toMatchObject({ ok: false, reason: 'no_distance' });
    });

    it('never uses a policy or a branch of another company', async () => {
      const b = await branch();
      await live(b);
      const foreign = await branch(null, otherCompany);
      expect(await c.deliveryQuotes.quote(otherCompany, { branchId: b, at: wednesday, currency: 'KES', weightKg: 1, orderValue: 1 })).toMatchObject({ ok: false, reason: 'no_branch' });
      expect(await c.deliveryQuotes.quote(companyId, { branchId: foreign, at: wednesday, currency: 'KES', weightKg: 1, orderValue: 1 })).toMatchObject({ ok: false, reason: 'no_branch' });
    });
  });

  describe('matching the zone codes of a pasted rate card', () => {
    it('finds this company’s zones by code in any case, and says which are unknown and which are stopped', async () => {
      const a = await zone('Westlands');
      const stopped = await zone('Old');
      await db.update(schema.deliveryZones).set({ isActive: false }).where(eq(schema.deliveryZones.id, stopped));
      const codeOf = async (id: string) => (await db.select().from(schema.deliveryZones).where(eq(schema.deliveryZones.id, id)))[0]?.code ?? '';
      const [ac, sc] = [await codeOf(a), await codeOf(stopped)];
      const r = await actions.matchZoneCodesAction([ac.toLowerCase(), ac, sc, 'NOPE-1']);
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) return;
      expect(r.data.zones).toEqual([{ id: a, code: ac, name: 'Westlands' }]);
      expect(r.data.stopped).toEqual([sc]);
      expect(r.data.unknown).toEqual(['NOPE-1']);
    });

    it('never finds another company’s zone', async () => {
      const foreign = await zone('Theirs', otherCompany);
      const foreignCode = (await db.select().from(schema.deliveryZones).where(eq(schema.deliveryZones.id, foreign)))[0]?.code ?? '';
      const r = await actions.matchZoneCodesAction([foreignCode]);
      expect(r).toMatchObject({ ok: true, data: { zones: [], stopped: [], unknown: [foreignCode] } });
    });

    it('refuses what is not a short list of codes', async () => {
      for (const bad of ['NBO', null, [1], ['has space'], ['"; drop table'], new Array<string>(201).fill('A')]) {
        expect(await actions.matchZoneCodesAction(bad)).toMatchObject({ ok: false, code: 'BAD_INPUT' });
      }
      expect(await actions.matchZoneCodesAction([])).toMatchObject({ ok: true, data: { zones: [], stopped: [], unknown: [] } });
    });

    it('asks for deliveries:read and nothing else', async () => {
      requirePermission.mockClear();
      await actions.matchZoneCodesAction(['X']);
      expect(requirePermission.mock.calls.map((call: unknown[]) => call.at(0))).toEqual(['deliveries:read']);
      requirePermission.mockRejectedValue(new Error('Forbidden'));
      expect((await actions.matchZoneCodesAction(['X'])).ok).toBe(false);
    });
  });

  describe('permissions', () => {
    it('reading and the simulator ask for deliveries:read, and every change asks for delivery_rates:manage', async () => {
      const b = await branch();
      const d = await draft(b);
      requirePermission.mockClear();
      await actions.chargePoliciesPageAction({});
      await actions.getChargePolicyAction(d.id);
      await actions.quoteDeliveryAction({ branchId: b });
      await actions.createChargePolicyDraftAction(code(), flatInput(b));
      await actions.saveChargePolicyDraftAction(d.id, flatInput(b), 1);
      await actions.activateChargePolicyAction(d.id, 'Because the test says so');
      await actions.retireChargePolicyAction(d.id, 'Because the test says so');
      await actions.newChargePolicyVersionAction(d.id);
      await actions.deleteChargePolicyDraftAction(randomUUID());
      expect(requirePermission.mock.calls.map((call: unknown[]) => call.at(0))).toEqual(['deliveries:read', 'deliveries:read', 'deliveries:read', ...new Array<string>(6).fill('delivery_rates:manage')]);
    });

    it('nobody without the permission sees or changes anything', async () => {
      const b = await branch();
      const d = await draft(b);
      requirePermission.mockRejectedValue(new Error('Forbidden'));
      for (const call of [actions.chargePoliciesPageAction({}), actions.getChargePolicyAction(d.id), actions.quoteDeliveryAction({ branchId: b }), actions.createChargePolicyDraftAction(code(), flatInput(b)), actions.saveChargePolicyDraftAction(d.id, flatInput(b), 1), actions.activateChargePolicyAction(d.id, 'Forbidden anyway'), actions.deleteChargePolicyDraftAction(d.id)]) expect((await call).ok).toBe(false);
      expect((await row(d.id))?.status).toBe('draft');
    });

    it('treat another company’s policy as not found', async () => {
      const [foreign] = await db.insert(schema.chargePolicies).values({ companyId: otherCompany, code: code(), name: 'Foreign', method: 'flat', currency: 'KES', createdBy: 'x' }).returning();
      const id = foreign?.id ?? '';
      expect(await actions.getChargePolicyAction(id)).toMatchObject({ ok: false, error: 'That policy could not be found.' });
      expect(await actions.activateChargePolicyAction(id, 'Not ours to activate')).toMatchObject({ ok: false, error: 'That policy could not be found.' });
      expect(await actions.deleteChargePolicyDraftAction(id)).toMatchObject({ ok: false });
      await db.delete(schema.chargePolicies).where(eq(schema.chargePolicies.id, id));
    });
  });
});
