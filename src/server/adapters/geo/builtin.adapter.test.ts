import { describe, expect, it } from 'vitest';
import { straightLineKm } from '@/lib/geo';
import { BuiltinGeoAdapter } from './builtin.adapter';
import { GeoPortRegistry, configuredGeoDriver, roadFactorFrom } from './registry';
import { runGeoPortContract } from './contract';
import type { GeoPort } from '@/server/ports/geo';

runGeoPortContract('builtin', () => new BuiltinGeoAdapter());

describe('the built-in map adapter', () => {
  it('estimates the road as the straight line times the factor, with a time at town speed', async () => {
    const a = { latitude: -1.2921, longitude: 36.8219 };
    const b = { latitude: -0.3031, longitude: 36.08 };
    const [r] = await new BuiltinGeoAdapter(1.5).distancesFrom(a, [b]);
    expect(r?.km).toBeCloseTo(straightLineKm(a, b) * 1.5, 1);
    expect(r?.basis).toBe('estimated');
    expect(r?.minutes).toBe(Math.round(((r?.km ?? 0) / 30) * 60));
  });
});

describe('choosing a map provider', () => {
  const fake = (name: string): GeoPort => ({ provider: name, capabilities: new BuiltinGeoAdapter().capabilities, searchPlaces: () => Promise.resolve([]), resolvePlace: () => Promise.resolve(null), reverse: () => Promise.resolve(null), distancesFrom: () => Promise.resolve([]) });
  const adapters = { builtin: () => new BuiltinGeoAdapter(), acme: () => fake('acme') };

  it('uses the built-in one when nothing is set', () => {
    expect(configuredGeoDriver({}, adapters)).toBe('builtin');
    expect(configuredGeoDriver({ GEO_DRIVER: '  ' }, adapters)).toBe('builtin');
  });
  it('uses the one named, in any case, and refuses a name nobody registered, saying the choices', () => {
    expect(configuredGeoDriver({ GEO_DRIVER: 'ACME' }, adapters)).toBe('acme');
    expect(() => configuredGeoDriver({ GEO_DRIVER: 'nope' }, adapters)).toThrow(/Use one of: builtin, acme/);
    expect(() => configuredGeoDriver({ GEO_DRIVER: 'constructor' }, adapters)).toThrow(/Unknown GEO_DRIVER/);
  });
  it('adds a provider with one registration and nothing else, builds each once, and always keeps the built-in one to fall back on', () => {
    let built = 0;
    const registry = new GeoPortRegistry({ GEO_DRIVER: 'acme' }, { ...adapters, acme: () => { built += 1; return fake('acme'); } });
    expect(registry.active().provider).toBe('acme');
    expect(registry.active()).toBe(registry.active());
    expect(built).toBe(1);
    expect(registry.fallback().provider).toBe('builtin');
    expect(() => registry.named('missing')).toThrow(/Unknown map provider/);
  });
  it('reads the road factor, and ignores nonsense', () => {
    expect(roadFactorFrom({})).toBe(1.3);
    expect(roadFactorFrom({ GEO_ROAD_FACTOR: '1.6' })).toBe(1.6);
    for (const bad of ['0.5', '9', 'abc', '']) expect(roadFactorFrom({ GEO_ROAD_FACTOR: bad })).toBe(1.3);
  });
});
