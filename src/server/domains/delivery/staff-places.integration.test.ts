import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as ZoneActions from './actions';
import type * as PolicyActions from './policy-actions';
import type * as BranchActions from '@/server/domains/branches/actions';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Staff finding a place by name to fill a map pin, against a real database (the per-person limit is kept there): the three screens that
 * offer it each ask for their own permission, a short name is refused, only places with a point are offered, and one person cannot run up
 * the map service's bill.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('staff finding a place by name (database)', () => {
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let zones: typeof ZoneActions;
  let policies: typeof PolicyActions;
  let branches: typeof BranchActions;
  let search: ReturnType<typeof vi.spyOn>;
  const asked: string[] = [];
  let person = randomUUID();

  beforeAll(async () => {
    c = (await import('@/server/di/container')).getContainer();
    zones = await import('./actions');
    policies = await import('./policy-actions');
    branches = await import('@/server/domains/branches/actions');
    search = vi.spyOn(c.geo, 'searchPlaces').mockImplementation((query: string) => {
      asked.push(query);
      return Promise.resolve({
        value: [
          { id: 'a', label: 'Westlands, Nairobi', secondary: 'Nairobi County', point: { latitude: -1.2676, longitude: 36.8108 } },
          { id: 'b', label: 'A place with no point', secondary: null, point: null },
        ],
        degraded: false,
        provider: 'test',
      });
    });
  });
  afterAll(() => {
    search.mockRestore();
  });
  beforeEach(() => {
    asked.length = 0;
    person = randomUUID();
    requirePermission.mockReset().mockImplementation(() => Promise.resolve(person));
  });

  it('offers the places that have a point, for a name of three letters or more, trimmed, from each of the three screens', async () => {
    for (const find of [zones.findZonePlaceAction, policies.findChargePlaceAction, branches.findBranchPlaceAction]) {
      const found = await find('  Westlands  ');
      expect(found).toMatchObject({ ok: true, data: [{ id: 'a', label: 'Westlands, Nairobi', secondary: 'Nairobi County', point: { latitude: -1.2676, longitude: 36.8108 } }] });
      expect(found.ok && found.data).toHaveLength(1);
    }
    expect(asked).toEqual(['Westlands', 'Westlands', 'Westlands']);
    // Too short, empty, or not text: refused in words, and the map service is not asked.
    asked.length = 0;
    for (const bad of ['', 'ab', '  a ', undefined, null, 7, { q: 'Westlands' }]) expect(await zones.findZonePlaceAction(bad)).toMatchObject({ ok: false, error: expect.stringContaining('three letters') as string });
    expect(asked).toEqual([]);
    // A very long name is cut to what a place name can be.
    await zones.findZonePlaceAction('x'.repeat(400));
    expect(asked.at(0)).toHaveLength(120);
  });

  it('asks for the permission of the screen it is on, and asks the map service nothing when it is refused', async () => {
    requirePermission.mockClear();
    await zones.findZonePlaceAction('Westlands');
    await policies.findChargePlaceAction('Westlands');
    await branches.findBranchPlaceAction('Westlands');
    expect(requirePermission.mock.calls.map((call: unknown[]) => call.at(0))).toEqual(['deliveries:manage', 'deliveries:read', 'branches:manage']);
    asked.length = 0;
    requirePermission.mockRejectedValue(new Error('Forbidden'));
    for (const find of [zones.findZonePlaceAction, policies.findChargePlaceAction, branches.findBranchPlaceAction]) expect((await find('Westlands')).ok).toBe(false);
    expect(asked).toEqual([]);
  });

  it('limits each person, so one cannot run up the map service\'s bill, and not the next person', async () => {
    for (let n = 0; n < 60; n += 1) expect((await zones.findZonePlaceAction('Westlands')).ok).toBe(true);
    const over = await zones.findZonePlaceAction('Westlands');
    expect(over).toMatchObject({ ok: false, error: expect.stringMatching(/try again|minute|wait/i) as string });
    expect(asked).toHaveLength(60);
    person = randomUUID();
    expect((await policies.findChargePlaceAction('Westlands')).ok).toBe(true);
  });
});
