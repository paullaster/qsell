import { straightLineKm, type GeoPoint } from '@/lib/geo';
import { nearestNext, type StopPoint } from '@/lib/dispatch-run';

/** The length of a route in kilometres, in straight lines: from the start (when there is one) to the first stop, then stop to stop. */
export function routeKm(start: GeoPoint | null, points: readonly GeoPoint[]): number {
  let km = 0;
  let here = start;
  for (const p of points) {
    if (here !== null) km += straightLineKm(here, p);
    here = p;
  }
  return Math.round(km * 100) / 100;
}

/** "12.4 km", or "850 m" under a kilometre. */
export const kmWords = (km: number): string => (km < 1 ? `${String(Math.round(km * 1000))} m` : `${String(Math.round(km * 10) / 10)} km`);

/** What a person is told after the stops are put in the shortest order: how long the route is now and what it saved against what it was. */
export function routeSavingWords(beforeKm: number | null, afterKm: number | null): string {
  if (afterKm === null) return 'The stops are in the shortest order found. None has a map pin, so the length cannot be measured.';
  const base = `The stops are in the shortest order found: the route is about ${kmWords(afterKm)} in straight lines.`;
  if (beforeKm === null) return base;
  const saved = Math.round((beforeKm - afterKm) * 100) / 100;
  if (saved <= 0.01) return `${base} It was already as short as this can find.`;
  return `${base} That is ${kmWords(saved)} less than before.`;
}

/** Up to this many stops the best possible route is found exactly (dynamic programming over the subsets of stops: 12 stops is about 600,000 steps). */
export const MAX_EXACT_STOPS = 12;

/** The best open route from the start through every point, exactly (Held-Karp). `fixedFirst`: no start, so the first point is where the route begins. */
function exactOrder(start: GeoPoint | null, points: readonly GeoPoint[]): number[] {
  const origin = start ?? points[0];
  const nodes = start === null ? points.slice(1).map((p, i) => ({ p, i: i + 1 })) : points.map((p, i) => ({ p, i }));
  if (origin === undefined || nodes.length === 0) return points.map((_, i) => i);
  const n = nodes.length;
  const full = (1 << n) - 1;
  const fromOrigin = nodes.map((a) => straightLineKm(origin, a.p));
  const between = nodes.map((a) => nodes.map((b) => straightLineKm(a.p, b.p)));
  const cost = Array.from({ length: full + 1 }, () => new Array<number>(n).fill(Number.POSITIVE_INFINITY));
  const came = Array.from({ length: full + 1 }, () => new Array<number>(n).fill(-1));
  nodes.forEach((_, j) => {
    (cost[1 << j] as number[])[j] = fromOrigin[j] ?? 0;
  });
  for (let mask = 1; mask <= full; mask += 1) {
    for (let last = 0; last < n; last += 1) {
      const here = (cost[mask] as number[])[last] ?? Number.POSITIVE_INFINITY;
      if ((mask & (1 << last)) === 0 || here === Number.POSITIVE_INFINITY) continue;
      for (let next = 0; next < n; next += 1) {
        if ((mask & (1 << next)) !== 0) continue;
        const grown = mask | (1 << next);
        const km = here + ((between[last] as number[])[next] ?? 0);
        if (km < ((cost[grown] as number[])[next] ?? Number.POSITIVE_INFINITY) - 1e-12) {
          (cost[grown] as number[])[next] = km;
          (came[grown] as number[])[next] = last;
        }
      }
    }
  }
  let last = 0;
  for (let j = 1; j < n; j += 1) if (((cost[full] as number[])[j] ?? Infinity) < ((cost[full] as number[])[last] ?? Infinity) - 1e-12) last = j;
  const reverse: number[] = [];
  let mask = full;
  while (last !== -1) {
    reverse.push((nodes[last] as { i: number }).i);
    const before = (came[mask] as number[])[last] ?? -1;
    mask &= ~(1 << last);
    last = before;
  }
  return [...(start === null ? [0] : []), ...reverse.reverse()];
}

/** Past this many stops the improvement is not tried (the cost grows with the cube); the nearest-next order is kept. A van does not carry more. */
export const MAX_PLANNED_STOPS = 60;
const MAX_PASSES = 50;

/**
 * The shortest route this can find from the start through every stop (an open route: the rider is not brought back). Above 12 stops it begins
 * with the nearest-next order and then keeps improving it while that is possible: turning a stretch of the route around (2-opt) and moving one stop
 * to a better place (or-opt). The answer is never longer than nearest-next, and the same stops always give the same order. It is a good
 * route, not a proved best one (that is a hard problem; a vendor's planner can sit behind the same port). Up to 12 stops it is exact: the best
 * possible route is found by trying every way of building it up (dynamic programming), not guessed. A stop with no map pin goes after
 * the ones that have one, in the order given, as with nearest-next.
 */
export function shortestRoute(start: GeoPoint | null, stops: readonly StopPoint[]): string[] {
  const base = nearestNext(start, stops);
  const pins = new Map(stops.filter((s): s is StopPoint & { point: GeoPoint } => s.point !== null).map((s) => [s.id, s.point]));
  const placed = base.filter((id) => pins.has(id));
  const unplaced = base.filter((id) => !pins.has(id));
  if (placed.length < 3 || placed.length > MAX_PLANNED_STOPS) return base;
  // Few enough stops to find the very best route, not only a good one.
  if (placed.length <= MAX_EXACT_STOPS) {
    const points = placed.map((id) => pins.get(id) as GeoPoint);
    return [...exactOrder(start, points).map((i) => placed[i] as string), ...unplaced];
  }
  // With no start the first stop is where the route begins, and stays first.
  const lengthOf = (ids: readonly string[]): number => routeKm(start, ids.map((id) => pins.get(id) as GeoPoint));
  let best = [...placed];
  let bestKm = lengthOf(best);
  const first = start === null ? 1 : 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let improved = false;
    for (let i = first; i < best.length - 1 && !improved; i += 1) {
      for (let j = i + 1; j < best.length && !improved; j += 1) {
        const turned = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const km = lengthOf(turned);
        if (km < bestKm - 1e-9) {
          best = turned;
          bestKm = km;
          improved = true;
        }
      }
    }
    for (let i = first; i < best.length && !improved; i += 1) {
      for (let to = first; to < best.length && !improved; to += 1) {
        if (to === i) continue;
        const moved = [...best];
        const [one] = moved.splice(i, 1);
        if (one === undefined) continue;
        moved.splice(to, 0, one);
        const km = lengthOf(moved);
        if (km < bestKm - 1e-9) {
          best = moved;
          bestKm = km;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return [...best, ...unplaced];
}
