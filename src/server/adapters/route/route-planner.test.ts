import { describe, expect, it } from 'vitest';
import { ROUTE_PLANNER_IDS, routePlanner } from './registry';

const request = { start: { latitude: 0, longitude: 0 }, stops: [{ id: 'a', point: { latitude: 0, longitude: 1 } }, { id: 'b', point: { latitude: 0, longitude: -1.1 } }, { id: 'c', point: null }, { id: 'd', point: { latitude: 0, longitude: 3 } }] };

describe('the route planners behind the port', () => {
  it('offers the two in-house planners by name and nothing it does not know', () => {
    expect(ROUTE_PLANNER_IDS).toEqual(['nearest', 'shortest']);
    expect(routePlanner('nearest')?.name).toBe('nearest');
    expect(routePlanner('shortest')?.name).toBe('shortest');
    for (const bad of ['', 'fastest', undefined, null, 7, '__proto__', 'constructor']) expect(routePlanner(bad)).toBeNull();
  });

  it('each answers every stop once, those with no pin last', async () => {
    for (const id of ROUTE_PLANNER_IDS) {
      const plan = await routePlanner(id)?.plan(request);
      expect([...(plan?.order ?? [])].sort()).toEqual(['a', 'b', 'c', 'd']);
      expect(plan?.order.at(-1)).toBe('c');
    }
  });
});
