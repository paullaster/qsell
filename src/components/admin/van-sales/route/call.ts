import type { RouteScreen } from '@/server/domains/van-sales/actions';

/**
 * Runs one change to the route and shows the refreshed route. It answers null when the change was made, or the words it was refused
 * in (also shown to the person by the form that asked), so a form knows whether to close.
 */
export type RouteCall = (call: Promise<{ ok: true; data: RouteScreen } | { ok: false; error: string }>, okText: string) => Promise<string | null>;
