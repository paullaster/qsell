import { nearestNext } from '@/lib/dispatch-run';
import { shortestRoute } from '@/lib/route-plan';
import type { RoutePlan, RoutePlannerPort, RouteRequest } from '@/server/ports/route-optimiser';

/** The planners that need no outside service. They work on straight-line distances between the map pins. */
export class InHouseRoutePlanner implements RoutePlannerPort {
  constructor(readonly name: 'nearest' | 'shortest') {}

  plan(request: RouteRequest): Promise<RoutePlan> {
    const stops = [...request.stops];
    return Promise.resolve({ order: this.name === 'nearest' ? nearestNext(request.start, stops) : shortestRoute(request.start, stops) });
  }
}
