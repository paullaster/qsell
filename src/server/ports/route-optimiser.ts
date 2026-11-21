import type { GeoPoint } from '@/lib/geo';

/**
 * Route planning (DI port). Given where a run starts and where its stops are, a planner answers the order to do them in. The in-house
 * planners are adapters of this port; a vendor's optimiser (with traffic, time windows, vehicle loads) is another adapter, and nothing that
 * uses a planner changes. Domain code depends on this interface only.
 */
export interface RouteRequest {
  /** The branch the run leaves from, when it has a map pin. */
  start: GeoPoint | null;
  /** Every stop of the run, by delivery id; a stop with no map pin has none. */
  stops: readonly { id: string; point: GeoPoint | null }[];
}

export interface RoutePlan {
  /** Every delivery id of the request, once each. */
  order: string[];
}

export interface RoutePlannerPort {
  /** The id the screen and the decision log use ('nearest', 'shortest', a vendor's name). */
  readonly name: string;
  plan(request: RouteRequest): Promise<RoutePlan>;
}
