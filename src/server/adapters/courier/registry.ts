import { HttpJsonCourierAdapter } from './http-json';
import { ManualCourierAdapter } from './manual';
import type { HttpCourierSettings } from '@/lib/courier-http';
import type { CourierPort } from './port';

/** The kinds of courier connection that exist. A courier's own API is a new kind here, or settings of the http_json one. */
export const COURIER_ADAPTER_IDS = ['manual', 'http_json'] as const;
export type CourierAdapterId = (typeof COURIER_ADAPTER_IDS)[number];
export const isAdapterId = (value: unknown): value is CourierAdapterId => typeof value === 'string' && (COURIER_ADAPTER_IDS as readonly string[]).includes(value);

export const ADAPTER_WORDS: Record<CourierAdapterId, string> = { manual: 'By hand (typed in)', http_json: 'Courier\'s system (JSON over https)' };

/**
 * The adapter for a courier. An id the registry does not know, or a connection with no settings or key, gets the manual adapter, so a retired
 * or half-set courier never strands a delivery: its news is typed in.
 */
export function courierAdapter(id: string, connection?: { settings: HttpCourierSettings; key: string }): CourierPort {
  if (id === 'http_json' && connection !== undefined) return new HttpJsonCourierAdapter(connection.settings, connection.key);
  return new ManualCourierAdapter();
}
