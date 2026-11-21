import { describe, expect, it } from 'vitest';
import { nearestNext, type StopPoint } from './dispatch-run';
import type { GeoPoint } from './geo';
import { MAX_PLANNED_STOPS, kmWords, routeKm, routeSavingWords, shortestRoute } from './route-plan';

const at = (latitude: number, longitude: number): GeoPoint => ({ latitude, longitude });
const stop = (id: string, point: GeoPoint | null): StopPoint => ({ id, point });

/** The same stops from a seed, so a run of the test is the same every time. */
function scatter(seed: number, count: number): StopPoint[] {
  let x = seed;
  const next = (): number => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
  return Array.from({ length: count }, (_, i) => stop(`s${String(i)}`, at(-1.35 + next() * 0.2, 36.7 + next() * 0.3)));
}

const lengthOf = (start: GeoPoint | null, order: readonly string[], stops: readonly StopPoint[]): number => routeKm(start, order.flatMap((id) => { const p = stops.find((s) => s.id === id)?.point; return p === undefined || p === null ? [] : [p]; }));

describe('the length of a route', () => {
  it('is the straight lines from the start through each stop, and nothing back', () => {
    expect(routeKm(null, [])).toBe(0);
    expect(routeKm(null, [at(0, 0)])).toBe(0);
    // One degree of longitude on the equator is about 111.2 km.
    expect(routeKm(at(0, 0), [at(0, 1)])).toBeCloseTo(111.19, 1);
    expect(routeKm(at(0, 0), [at(0, 1), at(0, 2)])).toBeCloseTo(222.39, 1);
    // With no start it begins at the first stop.
    expect(routeKm(null, [at(0, 1), at(0, 2)])).toBeCloseTo(111.19, 1);
  });
});

describe('the shortest route', () => {
  it('has every stop once, with the stops that have no pin last in the order given', () => {
    const stops = [...scatter(7, 8), stop('x1', null), stop('x2', null)];
    const order = shortestRoute(at(-1.28, 36.82), stops);
    expect([...order].sort()).toEqual(stops.map((s) => s.id).sort());
    expect(order.slice(-2)).toEqual(['x1', 'x2']);
  });

  it('is never longer than nearest next, and is sometimes shorter', () => {
    const start = at(-1.28, 36.82);
    let shorter = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const stops = scatter(seed, 9);
      const near = lengthOf(start, nearestNext(start, stops), stops);
      const best = lengthOf(start, shortestRoute(start, stops), stops);
      expect(best).toBeLessThanOrEqual(near + 1e-6);
      if (best < near - 1e-6) shorter += 1;
    }
    expect(shorter).toBeGreaterThan(5);
  });

  it('finds the very best route for up to twelve stops, checked against every possible order', () => {
    const permutations = <T,>(items: readonly T[]): T[][] => (items.length <= 1 ? [[...items]] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));
    const start = at(-1.28, 36.82);
    let optimal = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const stops = scatter(seed + 100, 6);
      const best = Math.min(...permutations(stops.map((s) => s.id)).map((order) => lengthOf(start, order, stops)));
      const got = lengthOf(start, shortestRoute(start, stops), stops);
      expect(got).toBeGreaterThanOrEqual(best - 1e-6);
      if (got <= best + 1e-6) optimal += 1;
    }
    expect(optimal).toBe(40);
    // And with no start the first stop stays first and the rest are the best order after it.
    for (let seed = 1; seed <= 15; seed += 1) {
      const stops = scatter(seed + 500, 7);
      const best = Math.min(...permutations(stops.slice(1).map((s) => s.id)).map((order) => lengthOf(null, ['s0', ...order], stops)));
      const got = shortestRoute(null, stops);
      expect(got[0]).toBe('s0');
      expect(lengthOf(null, got, stops)).toBeLessThanOrEqual(best + 1e-6);
    }
  });

  it('improves a long route too, past the exact limit, and never makes it longer', () => {
    const start = at(-1.28, 36.82);
    for (let seed = 1; seed <= 8; seed += 1) {
      const stops = scatter(seed + 900, 25);
      expect(lengthOf(start, shortestRoute(start, stops), stops)).toBeLessThanOrEqual(lengthOf(start, nearestNext(start, stops), stops) + 1e-6);
    }
  });

  it('leaves small and huge cases to nearest next, and keeps the first stop first when there is no start', () => {
    const two = [stop('a', at(0, 1)), stop('b', at(0, 2))];
    expect(shortestRoute(at(0, 0), two)).toEqual(nearestNext(at(0, 0), two));
    const many = scatter(3, MAX_PLANNED_STOPS + 1);
    expect(shortestRoute(at(-1.28, 36.82), many)).toEqual(nearestNext(at(-1.28, 36.82), many));
    const stops = scatter(11, 8);
    expect(shortestRoute(null, stops)[0]).toBe('s0');
  });

  it('gives the same order every time, and nothing for no stops', () => {
    const stops = scatter(5, 10);
    expect(shortestRoute(at(-1.3, 36.8), stops)).toEqual(shortestRoute(at(-1.3, 36.8), stops));
    expect(shortestRoute(at(-1.3, 36.8), [])).toEqual([]);
    expect(shortestRoute(at(-1.3, 36.8), [stop('only', null)])).toEqual(['only']);
  });
});

describe('what the person is told', () => {
  it('writes a length in metres or kilometres', () => {
    expect(kmWords(0.85)).toBe('850 m');
    expect(kmWords(12.44)).toBe('12.4 km');
  });
  it('says what the route is and what it saved, or that it was already short', () => {
    expect(routeSavingWords(14.2, 11.5)).toBe('The stops are in the shortest order found: the route is about 11.5 km in straight lines. That is 2.7 km less than before.');
    expect(routeSavingWords(11.5, 11.5)).toContain('already as short');
    expect(routeSavingWords(null, 8)).toBe('The stops are in the shortest order found: the route is about 8 km in straight lines.');
    expect(routeSavingWords(5, null)).toContain('has a map pin');
  });
});
