import { describe, expect, it } from 'vitest';
import { DEFAULT_USAGE, GEO_CONFIG_FIELDS, GEO_PROVIDERS, GEO_PROVIDER_IDS, estimateCost, monthlyVolumes, tieredCostUsd, volumeFit } from './geo-providers';

const geocoding = { free: 10_000, bands: [{ upTo: 100_000, perThousandUsd: 5 }, { upTo: 500_000, perThousandUsd: 4 }, { upTo: null, perThousandUsd: 3 }] };

describe('tieredCostUsd', () => {
  it('charges nothing inside the free allowance', () => {
    expect(tieredCostUsd(0, geocoding)).toBe(0);
    expect(tieredCostUsd(10_000, geocoding)).toBe(0);
  });
  it('charges each band at its own rate', () => {
    expect(tieredCostUsd(12_000, geocoding)).toBe(10); // 2,000 at $5 per 1,000
    expect(tieredCostUsd(100_000, geocoding)).toBe(450); // 90,000 at $5
    expect(tieredCostUsd(200_000, geocoding)).toBe(850); // 450 + 100,000 at $4
    expect(tieredCostUsd(600_000, geocoding)).toBe(450 + 1600 + 300); // + 100,000 at $3
  });
  it('never charges less for more', () => {
    let last = 0;
    for (let n = 0; n <= 800_000; n += 25_000) {
      const cost = tieredCostUsd(n, geocoding);
      expect(cost).toBeGreaterThanOrEqual(last);
      last = cost;
    }
  });
});

describe('monthlyVolumes', () => {
  it('counts lookups, route elements (branches plus the chosen leg and its return) and map views from orders', () => {
    expect(monthlyVolumes(DEFAULT_USAGE)).toEqual({ lookups: 2000, routeElements: 10_000, routeRequests: 4000, mapViews: 1000 });
  });
  it('is zero for no orders and ignores nonsense', () => {
    expect(monthlyVolumes({ ...DEFAULT_USAGE, ordersPerMonth: 0 })).toEqual({ lookups: 0, routeElements: 0, routeRequests: 0, mapViews: 0 });
    expect(monthlyVolumes({ ...DEFAULT_USAGE, ordersPerMonth: -5, branches: 0 }).routeElements).toBe(0);
  });
});

describe('estimateCost', () => {
  it('is free for the built-in estimate and OpenStreetMap', () => {
    expect(estimateCost('builtin', DEFAULT_USAGE).kind).toBe('free');
    expect(estimateCost('osm', DEFAULT_USAGE).kind).toBe('free');
  });
  it('is inside Google’s free allowance for a small shop', () => {
    const e = estimateCost('google', DEFAULT_USAGE);
    expect(e).toMatchObject({ kind: 'known', totalUsd: 0 });
  });
  it('grows with orders and adds up its lines', () => {
    const small = estimateCost('google', { ...DEFAULT_USAGE, ordersPerMonth: 10_000 });
    const big = estimateCost('google', { ...DEFAULT_USAGE, ordersPerMonth: 100_000 });
    expect(small.kind === 'known' && big.kind === 'known').toBe(true);
    if (small.kind !== 'known' || big.kind !== 'known') return;
    expect(small.totalUsd).toBeGreaterThan(0);
    expect(big.totalUsd).toBeGreaterThan(small.totalUsd);
    expect(Math.round(big.lines.reduce((n, l) => n + l.usd, 0) * 100) / 100).toBe(big.totalUsd);
    // 10,000 orders: 20,000 geocodes (10,000 over the free allowance at $5), 100,000 elements ($450), 10,000 map views (free).
    expect(small.lines.map((l) => l.usd)).toEqual([50, 450, 0]);
  });
  it('shows no number where the price could not be confirmed', () => {
    expect(estimateCost('mapbox', DEFAULT_USAGE).kind).toBe('unknown');
  });
});

describe('volumeFit', () => {
  it('warns when the free OpenStreetMap servers would carry too much', () => {
    expect(volumeFit('osm', DEFAULT_USAGE).level).toBe('good');
    expect(volumeFit('osm', { ...DEFAULT_USAGE, ordersPerMonth: 8_000 }).level).toBe('watch');
    expect(volumeFit('osm', { ...DEFAULT_USAGE, ordersPerMonth: 100_000 }).level).toBe('poor');
    expect(volumeFit('google', { ...DEFAULT_USAGE, ordersPerMonth: 100_000 }).level).toBe('good');
  });
});

describe('the catalogue', () => {
  it('describes every provider fully, with sources for the ones that have terms', () => {
    for (const id of GEO_PROVIDER_IDS) {
      const p = GEO_PROVIDERS[id];
      expect(p.id).toBe(id);
      for (const j of [p.cost, p.reliability, p.limits, p.typeahead, p.roadDistance, p.kenyaData]) expect(j.text.length).toBeGreaterThan(4);
      if (id !== 'builtin') expect(p.sources.length).toBeGreaterThan(0);
      for (const s of p.sources) expect(s.url).toMatch(/^https:\/\//);
    }
  });
  it('only the providers with an adapter can be chosen, and keyed ones say so', () => {
    expect(GEO_PROVIDER_IDS.filter((id) => GEO_PROVIDERS[id].adapterReady)).toEqual(['builtin', 'osm']);
    expect(GEO_PROVIDERS.google.needsKey).toBe(true);
  });
  it('asks only for the settings a ready provider uses', () => {
    expect(GEO_CONFIG_FIELDS.osm.filter((f) => f.required).map((f) => f.key)).toEqual(['contactEmail']);
    expect(GEO_CONFIG_FIELDS.builtin).toEqual([]);
  });
});
