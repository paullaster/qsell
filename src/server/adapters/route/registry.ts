import type { RoutePlannerPort } from '@/server/ports/route-optimiser';
import { InHouseRoutePlanner } from './in-house.adapter';

/** The planners that exist. A vendor's optimiser is added here, and offered on the run screen by the words below. */
export const ROUTE_PLANNER_IDS = ['nearest', 'shortest'] as const;
export type RoutePlannerId = (typeof ROUTE_PLANNER_IDS)[number];

const PLANNERS: Record<RoutePlannerId, RoutePlannerPort> = { nearest: new InHouseRoutePlanner('nearest'), shortest: new InHouseRoutePlanner('shortest') };

/** The planner of that id, or null for one that does not exist (so a made-up id from a browser is refused, never guessed at). */
export function routePlanner(id: unknown): RoutePlannerPort | null {
  return typeof id === 'string' && (ROUTE_PLANNER_IDS as readonly string[]).includes(id) ? PLANNERS[id as RoutePlannerId] : null;
}
