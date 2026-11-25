/**
 * Reading what a person types when they set up a route, its customers and the usual stock of its van (docs/architecture/van-sales.md
 * §4.2). Pure: each refusal is in words, and the server reads with this same code, so the screen and the server never disagree.
 */
import { MAX_QUANTITY, roundQty } from '@/lib/decimal';
import { isRecord } from '@/lib/values';
import { isId, NAME_LIMIT } from './people';
import { ROUTE_MODES, type RouteMode } from './settings';
import { dayNumber, readEvery, visitPlanProblem, type EveryWeeks } from './visits';

export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,18}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
export const NOTE_LIMIT = 300;

export interface RouteInput {
  code: string;
  name: string;
  branchId: string;
  mode: RouteMode;
  defaultVanId: string | null;
  defaultRepId: string | null;
}

export type RouteRead = { ok: true; route: RouteInput } | { ok: false; error: string };

const optionalId = (value: unknown): { ok: true; id: string | null } | { ok: false } => {
  if (value === undefined || value === null || value === '') return { ok: true, id: null };
  return isId(value) ? { ok: true, id: value } : { ok: false };
};

export function readRoute(raw: unknown): RouteRead {
  if (!isRecord(raw)) return { ok: false, error: 'The route could not be read.' };
  const code = typeof raw.code === 'string' ? raw.code.trim().replace(/\s+/g, ' ').toUpperCase() : '';
  if (!CODE_PATTERN.test(code)) return { ok: false, error: 'Give the route a short code of up to 20 letters, digits, spaces or dashes, such as KIAMBU-MON.' };
  const name = typeof raw.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < NAME_LIMIT.min || name.length > NAME_LIMIT.max) return { ok: false, error: `Give the route a name of ${String(NAME_LIMIT.min)} to ${String(NAME_LIMIT.max)} characters, such as Kiambu Monday.` };
  if (!isId(raw.branchId)) return { ok: false, error: 'Choose the branch the route starts from.' };
  const mode = ROUTE_MODES.find((m) => m === raw.mode);
  if (mode === undefined) return { ok: false, error: 'Choose what the route is for: van sell, pre-sell, or both.' };
  const van = optionalId(raw.defaultVanId);
  if (!van.ok) return { ok: false, error: 'Choose a van from the list, or leave it empty.' };
  const rep = optionalId(raw.defaultRepId);
  if (!rep.ok) return { ok: false, error: 'Choose a sales rep from the list, or leave it empty.' };
  return { ok: true, route: { code, name, branchId: raw.branchId, mode, defaultVanId: van.id, defaultRepId: rep.id } };
}

/** Why a van cannot be the usual van of a route in this mode (a pre-sell-only route has no van to sell from); null when it can. */
export const vanProblem = (mode: RouteMode, vanId: string | null): string | null => (mode === 'pre_sell' && vanId !== null ? 'A pre-sell route takes orders and sells nothing from a van, so it has no usual van. Choose van sell or both, or leave the van empty.' : null);

export interface StopInput {
  customerId: string;
  visitDays: number;
  every: EveryWeeks;
  anchor: string;
  note: string | null;
}

export type StopRead = { ok: true; stop: StopInput } | { ok: false; error: string };

export function readStop(raw: unknown): StopRead {
  if (!isRecord(raw)) return { ok: false, error: 'The stop could not be read.' };
  if (!isId(raw.customerId)) return { ok: false, error: 'Choose the customer from the list.' };
  const every = readEvery(raw.every);
  const problem = visitPlanProblem(raw.visitDays, every, raw.anchor);
  if (problem !== null || every === null) return { ok: false, error: problem ?? 'Choose how often to visit.' };
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length > NOTE_LIMIT) return { ok: false, error: `Keep the note to ${String(NOTE_LIMIT)} characters.` };
  return { ok: true, stop: { customerId: raw.customerId, visitDays: raw.visitDays as number, every, anchor: raw.anchor as string, note: note === '' ? null : note } };
}

/** The start date of a stop's visits, checked as a real date. */
export const isRealDate = (value: unknown): value is string => typeof value === 'string' && dayNumber(value) !== null;

export interface ParInput {
  productId: string;
  quantity: number;
}

export type ParRead = { ok: true; rows: ParInput[] } | { ok: false; error: string };

export const MAX_PAR_LINES = 500;

/** The usual stock of a route's van: each product once, with a quantity more than nothing. */
export function readPar(raw: unknown): ParRead {
  if (!Array.isArray(raw)) return { ok: false, error: 'The usual stock could not be read.' };
  if (raw.length > MAX_PAR_LINES) return { ok: false, error: `A route may list up to ${String(MAX_PAR_LINES)} products.` };
  const seen = new Set<string>();
  const rows: ParInput[] = [];
  for (const line of raw as unknown[]) {
    if (!isRecord(line) || typeof line.productId !== 'string' || line.productId === '' || line.productId.length > 100) return { ok: false, error: 'Choose each product from the list.' };
    if (seen.has(line.productId)) return { ok: false, error: 'A product can be listed once. Add its quantities together.' };
    seen.add(line.productId);
    const q = typeof line.quantity === 'number' ? line.quantity : Number(line.quantity);
    if (!Number.isFinite(q) || q <= 0 || q > MAX_QUANTITY) return { ok: false, error: 'Each quantity must be more than nothing.' };
    rows.push({ productId: line.productId, quantity: roundQty(q) });
  }
  return { ok: true, rows };
}

/**
 * The new order of a route's stops, as the person arranged them: it must name every stop on the route once and nothing else, so a stop
 * can never be lost or doubled by a reordering made from an out-of-date screen.
 */
export function readOrder(raw: unknown, current: readonly string[]): { ok: true; order: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.every((x): x is string => isId(x))) return { ok: false, error: 'The new order could not be read.' };
  const wanted = new Set(raw);
  const same = raw.length === current.length && wanted.size === raw.length && current.every((id) => wanted.has(id));
  return same ? { ok: true, order: raw } : { ok: false, error: 'The route has changed since you opened it. Reload the page and arrange the stops again.' };
}

/** Moves one stop up or down a place; null when it is already at that end or is not on the route. */
export function movedOrder(order: readonly string[], id: string, by: -1 | 1): string[] | null {
  const from = order.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
