import { describe, expect, it } from 'vitest';
import { straightLineKm, type GeoPoint } from '@/lib/geo';
import { OSM_DEFAULTS, type OsmConfig } from '@/lib/geo-config';
import { GeoUnavailableError } from '@/server/ports/geo';
import { runGeoPortContract } from './contract';
import { OsmGeoAdapter, type Fetcher } from './osm.adapter';

const config: OsmConfig = { contactEmail: 'maps@shop.co.ke', countryCodes: ['ke'], ...OSM_DEFAULTS };
const own: OsmConfig = { ...config, nominatimUrl: 'https://geo.shop.co.ke', osrmUrl: 'https://route.shop.co.ke' };

const westlands = { osm_type: 'node', osm_id: 12345, lat: '-1.2636', lon: '36.8030', display_name: 'Westlands, Nairobi, Nairobi County, Kenya', name: 'Westlands', address: { suburb: 'Westlands', city: 'Nairobi', county: 'Nairobi County', country_code: 'ke', road: 'Waiyaki Way' } };

interface Call {
  url: string;
  headers: Record<string, string>;
  at: number;
}

/** A pretend map server: answers like Nominatim and OSRM would, and keeps the calls it was given. */
function fakeServer(over: { status?: number; unroutable?: number; throws?: boolean } = {}) {
  const calls: Call[] = [];
  const clock = { now: 1_000_000 };
  const fetcher: Fetcher = (url, init) => {
    calls.push({ url, headers: init.headers, at: clock.now });
    if (over.throws === true) return Promise.reject(new Error('network down'));
    const reply = (body: unknown, status = over.status ?? 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    const u = new URL(url);
    if (u.pathname === '/search') return reply(u.searchParams.get('q')?.includes('zzzz') === true ? [] : [westlands]);
    if (u.pathname === '/lookup') return reply(u.searchParams.get('osm_ids') === 'N12345' ? [westlands] : []);
    if (u.pathname === '/reverse') return reply(Math.abs(Number(u.searchParams.get('lon'))) > 100 ? { error: 'Unable to geocode' } : westlands);
    if (u.pathname.startsWith('/table/v1/driving/')) {
      const points: GeoPoint[] = (u.pathname.split('/').pop() ?? '').split(';').map((p) => ({ longitude: Number(p.split(',')[0]), latitude: Number(p.split(',')[1]) }));
      const [from = { latitude: 0, longitude: 0 }, ...to] = points;
      const metres = to.map((p, i) => (i === over.unroutable ? null : Math.round(straightLineKm(from, p) * 1.25 * 1000)));
      return reply({ code: 'Ok', durations: [to.map((p) => Math.round(straightLineKm(from, p) * 1.25 * 60))], distances: [metres] });
    }
    return reply({}, 404);
  };
  return { calls, clock, deps: { fetch: fetcher, now: () => clock.now, sleep: (ms: number) => { clock.now += ms; return Promise.resolve(); } } };
}

const make = (cfg = config, over = {}) => {
  const server = fakeServer(over);
  return { adapter: new OsmGeoAdapter(cfg, 1.3, server.deps), ...server };
};

runGeoPortContract('OpenStreetMap (fake servers)', () => make().adapter);

describe('OsmGeoAdapter', () => {
  it('says it can search, give road distances and draw a map, but not search as people type on the public server', () => {
    const { adapter } = make();
    expect(adapter.capabilities).toMatchObject({ placeSearch: true, typeahead: false, reverseGeocode: true, roadDistance: true, travelTime: true });
    expect(adapter.capabilities.clientMap).toEqual({ driver: 'leaflet', options: { tileUrl: OSM_DEFAULTS.tileUrl, attribution: '© OpenStreetMap contributors' } });
    expect(make(own).adapter.capabilities.typeahead).toBe(true);
  });

  it('identifies the business to the servers and keeps results to the countries chosen', async () => {
    const { adapter, calls } = make();
    await adapter.searchPlaces('Westlands');
    expect(calls[0]?.headers['User-Agent']).toBe('qsell (maps@shop.co.ke)');
    expect(new URL(calls[0]?.url ?? '').searchParams.get('countrycodes')).toBe('ke');
  });

  it('turns a search result into a suggestion with its place, and finds the address parts of a Kenyan place', async () => {
    const { adapter } = make();
    const [hit] = await adapter.searchPlaces('Westlands');
    expect(hit).toMatchObject({ id: 'osm:N12345', label: 'Westlands', point: { latitude: -1.2636, longitude: 36.803 } });
    expect(hit?.secondary).toBe('Nairobi, Nairobi County, Kenya');
    const place = await adapter.resolvePlace('osm:N12345');
    expect(place).toMatchObject({ county: 'Nairobi', town: 'Nairobi', area: 'Westlands', road: 'Waiyaki Way', countryCode: 'ke' });
    expect(await adapter.resolvePlace('osm:N99')).toBeNull();
    expect(await adapter.resolvePlace('not-ours')).toBeNull();
    expect(await adapter.resolvePlace('osm:N1;DROP')).toBeNull();
  });

  it('reverses a pin, and says nothing found for the middle of the sea', async () => {
    const { adapter } = make();
    expect((await adapter.reverse({ latitude: -1.26, longitude: 36.8 }))?.area).toBe('Westlands');
    expect(await adapter.reverse({ latitude: 0, longitude: -150 })).toBeNull();
  });

  it('spaces requests to the public servers a little over a second apart, one at a time', async () => {
    const { adapter, calls } = make();
    await Promise.all([adapter.searchPlaces('a1'), adapter.searchPlaces('b2'), adapter.searchPlaces('c3')]);
    const gaps = calls.slice(1).map((c, i) => c.at - (calls[i]?.at ?? 0));
    expect(gaps.every((g) => g >= 1100)).toBe(true);
  });

  it('does not hold back a server of your own', async () => {
    const { adapter, calls } = make(own);
    await Promise.all([adapter.searchPlaces('a1'), adapter.searchPlaces('b2')]);
    expect(calls.map((c) => c.at)).toEqual([1_000_000, 1_000_000]);
    expect(calls[0]?.url.startsWith('https://geo.shop.co.ke/search')).toBe(true);
  });

  it('remembers an answer for a day and then asks again', async () => {
    const { adapter, calls, clock } = make();
    await adapter.searchPlaces('Westlands');
    await adapter.searchPlaces('Westlands');
    expect(calls).toHaveLength(1);
    clock.now += 25 * 60 * 60 * 1000;
    await adapter.searchPlaces('Westlands');
    expect(calls).toHaveLength(2);
  });

  it('gives road distances and times in order, in one request', async () => {
    const { adapter, calls } = make(own);
    const nairobi = { latitude: -1.2921, longitude: 36.8219 };
    const out = await adapter.distancesFrom(nairobi, [{ latitude: -0.3031, longitude: 36.08 }, { latitude: -1.1, longitude: 37 }]);
    expect(calls).toHaveLength(1);
    expect(out.map((r) => r.basis)).toEqual(['road', 'road']);
    expect(out[0]?.km).toBeGreaterThan(out[1]?.km ?? 0);
    expect(out[0]?.minutes).toBeGreaterThan(0);
  });

  it('marks a place that cannot be reached by road as an estimate', async () => {
    const { adapter } = make(own, { unroutable: 1 });
    const out = await adapter.distancesFrom({ latitude: -1.29, longitude: 36.82 }, [{ latitude: -1.1, longitude: 37 }, { latitude: -1.0, longitude: 37.1 }]);
    expect(out.map((r) => r.basis)).toEqual(['road', 'estimated']);
  });

  it('splits a long list of destinations into several requests', async () => {
    const { adapter, calls } = make(own);
    const to = Array.from({ length: 200 }, (_, i) => ({ latitude: -1 - i / 1000, longitude: 36.9 }));
    const out = await adapter.distancesFrom({ latitude: -1.29, longitude: 36.82 }, to);
    expect(out).toHaveLength(200);
    expect(calls).toHaveLength(3);
  });

  it('is unavailable, not wrong, when the server fails, refuses or cannot be reached', async () => {
    await expect(make(config, { status: 429 }).adapter.searchPlaces('x1')).rejects.toBeInstanceOf(GeoUnavailableError);
    await expect(make(config, { status: 500 }).adapter.distancesFrom({ latitude: 0, longitude: 0 }, [{ latitude: 1, longitude: 1 }])).rejects.toBeInstanceOf(GeoUnavailableError);
    await expect(make(config, { throws: true }).adapter.reverse({ latitude: 0, longitude: 0 })).rejects.toBeInstanceOf(GeoUnavailableError);
  });

  it('does not remember a failure', async () => {
    const bad = make(config, { status: 503 });
    await expect(bad.adapter.searchPlaces('x1')).rejects.toBeDefined();
    await expect(bad.adapter.searchPlaces('x1')).rejects.toBeDefined();
    expect(bad.calls).toHaveLength(2);
  });
});
