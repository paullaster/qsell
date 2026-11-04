import { ManualCourierAdapter } from './manual';
import type { CourierPort } from './port';

/** The courier adapters that exist. A courier's own API is added here when one is chosen; every delivery names the adapter it uses. */
const ADAPTERS: Record<string, () => CourierPort> = { manual: () => new ManualCourierAdapter() };

export const COURIER_ADAPTER_IDS = Object.keys(ADAPTERS);

/** The adapter with this id, or the manual one when the id is not known (a retired adapter never strands a delivery). */
export function courierAdapter(id: string): CourierPort {
  return (ADAPTERS[id] ?? ADAPTERS.manual ?? (() => new ManualCourierAdapter()))();
}
