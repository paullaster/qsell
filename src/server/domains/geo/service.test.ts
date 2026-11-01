import { describe, expect, it } from 'vitest';
import { BuiltinGeoAdapter } from '@/server/adapters/geo/builtin.adapter';
import { GeoPortRegistry, type GeoSelection } from '@/server/adapters/geo/registry';
import { GeoUnavailableError, type GeoPoint, type GeoPort, type RouteEstimate } from '@/server/ports/geo';
import { GeoService, type GeoCallEvent } from './service';

const nairobi: GeoPoint = { latitude: -1.2921, longitude: 36.8219 };
const nakuru: GeoPoint = { latitude: -0.3031, longitude: 36.08 };
const kisumu: GeoPoint = { latitude: -0.0917, longitude: 34.768 };
const mombasa: GeoPoint = { latitude: -4.0435, longitude: 39.6682 };

/** A provider that answers as it is told to, to see how the service copes. */
function acme(behaviour: 'works' | 'fails' | 'hangs', road: Record<string, number> = {}): GeoPort {
  const base = new BuiltinGeoAdapter();
  const key = (p: GeoPoint) => `${String(p.latitude)},${String(p.longitude)}`;
  const answer = <T,>(value: () => T): Promise<T> => {
    if (behaviour === 'works') return Promise.resolve(value());
    if (behaviour === 'fails') return Promise.reject(new GeoUnavailableError('acme'));
    return new Promise<T>(() => undefined);
  };
  return {
    provider: 'acme',
    capabilities: { ...base.capabilities, placeSearch: true, roadDistance: true },
    searchPlaces: (q) => answer(() => [{ id: q, label: q, secondary: null, point: null }]),
    resolvePlace: () => Promise.resolve(null),
    reverse: () => answer(() => null),
    distancesFrom: (_from, to) => answer(() => to.map((p): RouteEstimate => ({ km: road[key(p)] ?? 10, minutes: 5, basis: 'road' }))),
  };
}
const serviceWith = (port: GeoPort, timeoutMs = 50) => new GeoService(new GeoPortRegistry({ GEO_DRIVER: 'acme' }, { builtin: () => new BuiltinGeoAdapter(), acme: () => port }), timeoutMs);

describe('the geo service', () => {
  it('uses the chosen provider when it answers', async () => {
    const r = await serviceWith(acme('works')).distancesFrom(nairobi, [nakuru]);
    expect(r).toMatchObject({ degraded: false, provider: 'acme', value: [{ km: 10, basis: 'road' }] });
  });
  it('falls back to the built-in estimate, and says so, when the provider fails', async () => {
    const r = await serviceWith(acme('fails')).distancesFrom(nairobi, [nakuru]);
    expect(r.degraded).toBe(true);
    expect(r.provider).toBe('builtin');
    expect(r.value[0]?.basis).toBe('estimated');
  });
  it('does not make a shopper wait on a provider that hangs', async () => {
    const started = Date.now();
    const r = await serviceWith(acme('hangs'), 40).distancesFrom(nairobi, [nakuru]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r).toMatchObject({ degraded: true, provider: 'builtin' });
  });
  it('answers a place search with nothing, not an error, when the provider is down; short text is not searched at all', async () => {
    expect(await serviceWith(acme('fails')).searchPlaces('Westlands')).toEqual({ value: [], degraded: true, provider: 'acme' });
    expect((await serviceWith(acme('works')).searchPlaces('W')).value).toEqual([]);
    expect((await serviceWith(acme('works')).searchPlaces('  Westlands ')).value[0]?.label).toBe('Westlands');
  });
  it('is never "degraded" for the built-in provider, which has nothing better to fall back to', async () => {
    const service = new GeoService(new GeoPortRegistry({}));
    expect(await service.reverse(nairobi)).toEqual({ value: null, degraded: false, provider: 'builtin' });
    expect((await service.capabilities()).placeSearch).toBe(false);
  });

  describe('what it records and which provider it uses', () => {
    const events: GeoCallEvent[] = [];
    const recording = (port: GeoPort, selection: GeoSelection | null = null) => {
      events.length = 0;
      let t = 0;
      return new GeoService(new GeoPortRegistry({ GEO_DRIVER: 'acme' }, { builtin: () => new BuiltinGeoAdapter(), acme: () => port }, selection), 50, (e) => events.push(e), () => (t += 40));
    };
    it('notes each call with its provider, kind, time and whether it worked', async () => {
      const service = recording(acme('works'));
      await service.searchPlaces('Westlands');
      await service.distancesFrom(nairobi, [nakuru]);
      expect(events).toEqual([
        { provider: 'acme', op: 'search', ms: 40, ok: true, fellBack: false },
        { provider: 'acme', op: 'distance', ms: 40, ok: true, fellBack: false },
      ]);
    });
    it('notes a failure, and a distance that fell back to the estimate', async () => {
      const service = recording(acme('fails'));
      await service.searchPlaces('Westlands');
      await service.distancesFrom(nairobi, [nakuru]);
      expect(events).toEqual([
        { provider: 'acme', op: 'search', ms: 40, ok: false, fellBack: false },
        { provider: 'acme', op: 'distance', ms: 40, ok: false, fellBack: true },
      ]);
    });
    it('uses the provider the administrator chose over the environment, and the built-in one when the choice cannot be built', async () => {
      const chosen = new GeoService(new GeoPortRegistry({ GEO_DRIVER: 'builtin' }, { builtin: () => new BuiltinGeoAdapter(), acme: () => acme('works') }, () => Promise.resolve({ driver: 'acme', config: {} })));
      expect((await chosen.searchPlaces('Westlands')).provider).toBe('acme');
      const broken = new GeoService(new GeoPortRegistry({}, { builtin: () => new BuiltinGeoAdapter(), acme: () => { throw new Error('bad setting'); } }, () => Promise.resolve({ driver: 'acme', config: {} })));
      expect((await broken.reverse(nairobi)).provider).toBe('builtin');
      const failing = new GeoService(new GeoPortRegistry({}, { builtin: () => new BuiltinGeoAdapter() }, () => Promise.reject(new Error('db down'))));
      expect((await failing.reverse(nairobi)).provider).toBe('builtin');
    });
  });

  describe('the nearest', () => {
    const branches = [{ item: 'MSA', point: mombasa }, { item: 'NKR', point: nakuru }, { item: 'NBO', point: nairobi }, { item: 'NEW', point: null }, { item: 'KSM', point: kisumu }];
    it('ranks by the distance the provider gives, with the route to each, and sets aside a branch with no pin', async () => {
      const r = await serviceWith(acme('works')).nearest({ latitude: -1.0, longitude: 36.5 }, branches);
      expect(r.unplaced).toEqual(['NEW']);
      expect(r.ranked).toHaveLength(4);
      expect(r.degraded).toBe(false);
    });
    it('puts the road before the crow: a provider that says the nearer-looking branch is further by road wins', async () => {
      const road = { [`${String(nairobi.latitude)},${String(nairobi.longitude)}`]: 90, [`${String(nakuru.latitude)},${String(nakuru.longitude)}`]: 20 };
      const r = await serviceWith(acme('works', road)).nearest({ latitude: -1.2, longitude: 36.7 }, [{ item: 'NBO', point: nairobi }, { item: 'NKR', point: nakuru }]);
      expect(r.ranked.map((x) => x.item)).toEqual(['NKR', 'NBO']);
      expect(r.ranked[0]?.route.km).toBe(20);
    });
    it('still ranks when the provider is down, by the estimate, and says so', async () => {
      const r = await serviceWith(acme('fails')).nearest({ latitude: -0.36, longitude: 35.29 }, branches);
      expect(r.degraded).toBe(true);
      expect(r.ranked.map((x) => x.item)).toEqual(['KSM', 'NKR', 'NBO', 'MSA']);
    });
    it('is stable: the same question gives the same order, and equal distances keep the order given', async () => {
      const twins = [{ item: 'B', point: nakuru }, { item: 'A', point: nakuru }];
      const first = await new GeoService(new GeoPortRegistry({})).nearest(nairobi, twins);
      expect(first.ranked.map((x) => x.item)).toEqual(['B', 'A']);
      expect((await new GeoService(new GeoPortRegistry({})).nearest(nairobi, twins)).ranked).toEqual(first.ranked);
    });
    it('copes with no branches and with none placed', async () => {
      expect(await new GeoService(new GeoPortRegistry({})).nearest(nairobi, [])).toMatchObject({ ranked: [], unplaced: [] });
      expect(await new GeoService(new GeoPortRegistry({})).nearest(nairobi, [{ item: 'X', point: null }])).toMatchObject({ ranked: [], unplaced: ['X'] });
    });
  });
});
