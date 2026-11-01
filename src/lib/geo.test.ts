import { describe, expect, it } from 'vitest';
import { estimatedRoadKm, isGeoPoint, rankByDistance, readGeoPoint, straightLineKm, type GeoPoint } from './geo';

const nairobi: GeoPoint = { latitude: -1.2921, longitude: 36.8219 };
const mombasa: GeoPoint = { latitude: -4.0435, longitude: 39.6682 };
const kisumu: GeoPoint = { latitude: -0.0917, longitude: 34.768 };
const nakuru: GeoPoint = { latitude: -0.3031, longitude: 36.08 };

describe('distance between places', () => {
  it('is zero from a place to itself and the same both ways', () => {
    expect(straightLineKm(nairobi, nairobi)).toBe(0);
    expect(straightLineKm(nairobi, mombasa)).toBeCloseTo(straightLineKm(mombasa, nairobi), 9);
  });
  it('matches known distances closely', () => {
    expect(straightLineKm(nairobi, mombasa)).toBeGreaterThan(436);
    expect(straightLineKm(nairobi, mombasa)).toBeLessThan(442);
    expect(straightLineKm(nairobi, kisumu)).toBeGreaterThan(262);
    expect(straightLineKm(nairobi, kisumu)).toBeLessThan(267);
    expect(straightLineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111.2, 0);
  });
  it('never exceeds half the earth’s circumference, even for opposite points', () => {
    const km = straightLineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
    expect(km).toBeLessThanOrEqual(20040);
    expect(km).toBeGreaterThan(20000);
  });
  it('obeys the triangle rule on a spread of places', () => {
    const places = [nairobi, mombasa, kisumu, nakuru, { latitude: 51.5, longitude: -0.12 }, { latitude: -33.9, longitude: 151.2 }];
    for (const a of places) for (const b of places) for (const c of places) expect(straightLineKm(a, c)).toBeLessThanOrEqual(straightLineKm(a, b) + straightLineKm(b, c) + 1e-6);
  });
  it('estimates a road distance with the company’s factor, never shorter than the straight line, rounded to 10 metres', () => {
    const line = straightLineKm(nairobi, nakuru);
    expect(estimatedRoadKm(nairobi, nakuru, 1.3)).toBeCloseTo(line * 1.3, 1);
    expect(estimatedRoadKm(nairobi, nakuru, 0.5)).toBeCloseTo(line, 1);
    expect(estimatedRoadKm(nairobi, nakuru, Number.NaN)).toBeCloseTo(line, 1);
    expect(estimatedRoadKm(nairobi, nakuru, 1.3)).toBe(estimatedRoadKm(nairobi, nakuru, 1.3));
    expect(Math.round(estimatedRoadKm(nairobi, nakuru, 1.37) * 100)).toBe(estimatedRoadKm(nairobi, nakuru, 1.37) * 100);
  });
});

describe('reading a point', () => {
  it('accepts numbers and typed text, and keeps six decimals', () => {
    expect(readGeoPoint('-1.2921456789', ' 36.8219 ')).toEqual({ ok: true, point: { latitude: -1.292146, longitude: 36.8219 } });
    expect(readGeoPoint(0, 0)).toEqual({ ok: true, point: { latitude: 0, longitude: 0 } });
  });
  it('refuses what is not a place, in words a person can read', () => {
    for (const [lat, lng] of [['', '36'], ['-1', ''], ['abc', '36'], [91, 0], [-91, 0], [0, 181], [0, -181], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY], [null, 3], [undefined, undefined]] as const) {
      const r = readGeoPoint(lat, lng);
      expect(r.ok, `${String(lat)},${String(lng)}`).toBe(false);
    }
    expect(readGeoPoint(95, 0)).toEqual({ ok: false, error: 'A latitude is between -90 and 90.' });
    expect(readGeoPoint(0, 200)).toEqual({ ok: false, error: 'A longitude is between -180 and 180.' });
  });
  it('knows a point when it sees one', () => {
    expect(isGeoPoint(nairobi)).toBe(true);
    expect(isGeoPoint({ latitude: 100, longitude: 0 })).toBe(false);
    expect(isGeoPoint({ latitude: '1', longitude: 0 })).toBe(false);
    expect(isGeoPoint(null)).toBe(false);
  });
});

describe('the nearest', () => {
  const branches = [
    { item: 'NBO', point: nairobi },
    { item: 'MSA', point: mombasa },
    { item: 'KSM', point: kisumu },
    { item: 'NKR', point: nakuru },
    { item: 'NEW', point: null },
  ];
  it('ranks nearest first and sets aside what has no place', () => {
    const { ranked, unplaced } = rankByDistance({ latitude: -0.36, longitude: 35.29 }, branches);
    expect(ranked.map((r) => r.item)).toEqual(['KSM', 'NKR', 'NBO', 'MSA']);
    expect(unplaced).toEqual(['NEW']);
    expect(ranked[0]?.km).toBeLessThan(ranked[1]?.km ?? 0);
  });
  it('breaks a tie by the order given, so the answer is always the same', () => {
    const here = { latitude: 1, longitude: 1 };
    const twins = [{ item: 'B', point: { latitude: 2, longitude: 1 } }, { item: 'A', point: { latitude: 2, longitude: 1 } }];
    expect(rankByDistance(here, twins).ranked.map((r) => r.item)).toEqual(['B', 'A']);
    expect(rankByDistance(here, [...twins].reverse()).ranked.map((r) => r.item)).toEqual(['A', 'B']);
  });
  it('gives nothing for no candidates, and uses the distance it is given', () => {
    expect(rankByDistance(nairobi, [])).toEqual({ ranked: [], unplaced: [] });
    const reversed = rankByDistance(nairobi, branches, (a, b) => -straightLineKm(a, b));
    expect(reversed.ranked[0]?.item).toBe('MSA');
  });
});
