/**
 * How a company runs van sales and pre-sales (docs/architecture/van-sales.md §16): which of the two modes are on and the few rules
 * every van day follows. Pure: no clock, no database. The server validates with `readSettings`; the screen uses the same words.
 */
import { isRecord } from '@/lib/values';

export const SHORTAGE_RULES = ['charge_rep', 'write_off'] as const;
export type ShortageRule = (typeof SHORTAGE_RULES)[number];
export const OFF_ROUTE_RULES = ['allow', 'refuse'] as const;
export type OffRouteRule = (typeof OFF_ROUTE_RULES)[number];
export const POSITION_RULES = ['record', 'require'] as const;
export type PositionRule = (typeof POSITION_RULES)[number];

export const SHORTAGE_WORDS: Record<ShortageRule, string> = {
  charge_rep: 'Charge the rep for what is missing',
  write_off: 'Write it off as a stock loss',
};
export const OFF_ROUTE_WORDS: Record<OffRouteRule, string> = {
  allow: 'A rep may sell to a customer who is not on the route (it is recorded as off-route)',
  refuse: 'A rep may sell only to the customers on the route',
};
export const POSITION_WORDS: Record<PositionRule, string> = {
  record: 'Record how far the rep was from the customer, and never stop the sale',
  require: 'The rep must be near the customer to start a visit',
};

export interface VanSalesSettings {
  /** Selling from a loaded van and handing the goods over on the spot. */
  vanSell: boolean;
  /** Taking orders on a visit, delivered later. */
  preSell: boolean;
  offRoute: OffRouteRule;
  /** Stock may stay on the van overnight, signed for. Off: the van is unloaded every day. */
  overnightStock: boolean;
  shortage: ShortageRule;
  /** A shortage worth more than this (KES, at cost) needs a second person to decide it. 0: every shortage does. */
  shortageApprovalAbove: number;
  position: PositionRule;
  /** How near (metres) counts as at the customer, when the position is required. */
  nearMetres: number;
}

export const VAN_SALES_DEFAULTS: VanSalesSettings = {
  vanSell: false,
  preSell: false,
  offRoute: 'allow',
  overnightStock: false,
  shortage: 'charge_rep',
  shortageApprovalAbove: 1000,
  position: 'record',
  nearMetres: 200,
};

export const NEAR_METRES = { min: 20, max: 5000 } as const;
export const MAX_APPROVAL_LIMIT = 100_000_000;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

export type SettingsRead = { ok: true; settings: VanSalesSettings } | { ok: false; error: string };

/** Reads the settings a person sent, refusing anything that is not one of the allowed values, in words. */
export function readSettings(raw: unknown): SettingsRead {
  if (!isRecord(raw)) return { ok: false, error: 'The settings could not be read.' };
  if (typeof raw.vanSell !== 'boolean' || typeof raw.preSell !== 'boolean') return { ok: false, error: 'Say whether van selling and pre-selling are on or off.' };
  if (!oneOf(OFF_ROUTE_RULES, raw.offRoute)) return { ok: false, error: 'Choose whether a rep may sell to a customer who is not on the route.' };
  if (typeof raw.overnightStock !== 'boolean') return { ok: false, error: 'Say whether stock may stay on the van overnight.' };
  if (!oneOf(SHORTAGE_RULES, raw.shortage)) return { ok: false, error: 'Choose what happens to stock that is missing from a van.' };
  const limit = raw.shortageApprovalAbove;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0 || limit > MAX_APPROVAL_LIMIT) return { ok: false, error: 'Give the shortage a second person must decide as an amount from 0 up (0 means every shortage).' };
  if (!oneOf(POSITION_RULES, raw.position)) return { ok: false, error: 'Choose what is done about how far a rep is from the customer.' };
  const near = raw.nearMetres;
  if (typeof near !== 'number' || !Number.isInteger(near) || near < NEAR_METRES.min || near > NEAR_METRES.max) return { ok: false, error: `Give how near counts as at the customer, in whole metres from ${String(NEAR_METRES.min)} to ${String(NEAR_METRES.max)}.` };
  return {
    ok: true,
    settings: { vanSell: raw.vanSell, preSell: raw.preSell, offRoute: raw.offRoute, overnightStock: raw.overnightStock, shortage: raw.shortage, shortageApprovalAbove: Math.round(limit * 100) / 100, position: raw.position, nearMetres: near },
  };
}

export type RouteMode = 'van_sell' | 'pre_sell' | 'both';
export const ROUTE_MODES: readonly RouteMode[] = ['van_sell', 'pre_sell', 'both'];
export const ROUTE_MODE_WORDS: Record<RouteMode, string> = { van_sell: 'Van sell', pre_sell: 'Pre-sell', both: 'Van sell and pre-sell' };

const MODES_NEEDED: Record<RouteMode, ('vanSell' | 'preSell')[]> = { van_sell: ['vanSell'], pre_sell: ['preSell'], both: ['vanSell', 'preSell'] };

/** The modes a route in this mode needs. */
export const modesNeeded = (mode: RouteMode): ('vanSell' | 'preSell')[] => MODES_NEEDED[mode];

/** Why a route cannot be in this mode while the company has the mode switched off; null when it can. */
export function routeModeProblem(settings: Pick<VanSalesSettings, 'vanSell' | 'preSell'>, mode: RouteMode): string | null {
  const missing = modesNeeded(mode).filter((m) => !settings[m]);
  if (missing.length === 0) return null;
  const names = missing.map((m) => (m === 'vanSell' ? 'van selling' : 'pre-selling')).join(' and ');
  return `${names.charAt(0).toUpperCase()}${names.slice(1)} ${missing.length === 1 ? 'is' : 'are'} switched off in Van sales settings.`;
}

/** Whether the company uses van sales at all (the screens appear only then). */
export const vanSalesOn = (s: Pick<VanSalesSettings, 'vanSell' | 'preSell'>): boolean => s.vanSell || s.preSell;
