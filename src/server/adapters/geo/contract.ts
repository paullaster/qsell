import { describe, expect, it } from 'vitest';
import { straightLineKm } from '@/lib/geo';
import type { GeoPort, GeoPoint } from '@/server/ports/geo';

const nairobi: GeoPoint = { latitude: -1.2921, longitude: 36.8219 };
const nakuru: GeoPoint = { latitude: -0.3031, longitude: 36.08 };
const kisumu: GeoPoint = { latitude: -0.0917, longitude: 34.768 };

/**
 * What every map provider adapter must do, whatever the provider. Run it from the adapter's own test with a way to build one
 * (a provider with a network is given a fake transport there, so this never calls out).
 */
export function runGeoPortContract(name: string, make: () => GeoPort): void {
  describe(`the map port contract: ${name}`, () => {
    it('names itself and says what it can do', () => {
      const port = make();
      expect(port.provider).not.toBe('');
      for (const key of ['placeSearch', 'reverseGeocode', 'roadDistance', 'travelTime'] as const) expect(typeof port.capabilities[key]).toBe('boolean');
      if (port.capabilities.clientMap !== null) {
        expect(port.capabilities.clientMap.driver).not.toBe('');
        // Only public values go to the browser.
        for (const [key, value] of Object.entries(port.capabilities.clientMap.options)) expect(`${key}=${value}`).not.toMatch(/secret|password|private/i);
      }
    });

    it('answers "nothing found" with an empty list or null, never an error', async () => {
      const port = make();
      const found = await port.searchPlaces('zzzzqqqq-no-such-place-xx');
      expect(Array.isArray(found)).toBe(true);
      if (!port.capabilities.placeSearch) expect(found).toEqual([]);
      expect(await port.resolvePlace('no-such-handle')).toBeNull();
      const out = await port.reverse({ latitude: 0, longitude: -150 });
      if (!port.capabilities.reverseGeocode) expect(out).toBeNull();
    });

    it('gives one distance per destination, in order, never shorter than the straight line, zero to the same place', async () => {
      const port = make();
      expect(await port.distancesFrom(nairobi, [])).toEqual([]);
      const out = await port.distancesFrom(nairobi, [nakuru, kisumu, nairobi]);
      expect(out).toHaveLength(3);
      expect(out[0]?.km).toBeGreaterThanOrEqual(straightLineKm(nairobi, nakuru) - 0.01);
      expect(out[1]?.km).toBeGreaterThanOrEqual(straightLineKm(nairobi, kisumu) - 0.01);
      expect(out[0]?.km).toBeLessThan(out[1]?.km ?? 0);
      expect(out[2]?.km).toBe(0);
      for (const r of out) {
        expect(Number.isFinite(r.km)).toBe(true);
        expect(['road', 'estimated']).toContain(r.basis);
        if (r.minutes !== null) expect(r.minutes).toBeGreaterThanOrEqual(0);
      }
    });

    it('says the same thing to the same question', async () => {
      const port = make();
      expect(await port.distancesFrom(nairobi, [nakuru, kisumu])).toEqual(await port.distancesFrom(nairobi, [nakuru, kisumu]));
    });
  });
}
