/**
 * Reading what a person types when they set up a van or a sales rep (docs/architecture/van-sales.md §4.1). Pure: every refusal is in words
 * and the server uses this same reading, so the screen and the server never disagree.
 */
import { MAX_MONEY } from '@/lib/decimal';
import { isRecord } from '@/lib/values';
import { readLimits, type RepLimits } from './rep-limits';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** An optional id: empty or missing is none, anything else must be a real id. */
const optionalId = (value: unknown): { ok: true; id: string | null } | { ok: false } => {
  if (value === undefined || value === null || value === '') return { ok: true, id: null };
  return isId(value) ? { ok: true, id: value } : { ok: false };
};

export const NAME_LIMIT = { min: 2, max: 60 } as const;
export const REASON_LIMIT = { min: 3, max: 300 } as const;

export interface VanInput {
  name: string;
  branchId: string;
  vehicleId: string | null;
  cashAccountId: string | null;
  maxCash: number | null;
}

export type VanRead = { ok: true; van: VanInput } | { ok: false; error: string };

export function readVan(raw: unknown): VanRead {
  if (!isRecord(raw)) return { ok: false, error: 'The van could not be read.' };
  const name = typeof raw.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < NAME_LIMIT.min || name.length > NAME_LIMIT.max) return { ok: false, error: `Give the van a name of ${String(NAME_LIMIT.min)} to ${String(NAME_LIMIT.max)} characters, such as its plate or the route it works.` };
  if (!isId(raw.branchId)) return { ok: false, error: 'Choose the branch the van belongs to.' };
  const vehicle = optionalId(raw.vehicleId);
  if (!vehicle.ok) return { ok: false, error: 'Choose a vehicle from the list, or leave it empty.' };
  const cash = optionalId(raw.cashAccountId);
  if (!cash.ok) return { ok: false, error: 'Choose a cash account from the list, or leave it empty.' };
  let maxCash: number | null = null;
  if (raw.maxCash !== undefined && raw.maxCash !== null && raw.maxCash !== '') {
    const n = typeof raw.maxCash === 'number' ? raw.maxCash : Number(raw.maxCash);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_MONEY) return { ok: false, error: 'The most cash a van should hold must be more than nothing, or left empty for no limit.' };
    maxCash = Math.round(n * 100) / 100;
  }
  return { ok: true, van: { name, branchId: raw.branchId, vehicleId: vehicle.id, cashAccountId: cash.id, maxCash } };
}

/** The stock location code of a van: `VAN-` and what is letters or digits in its name, made different from those already used. */
export function locationCodeFor(name: string, taken: ReadonlySet<string>): string {
  const base = `VAN-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/g, '')}`;
  const stem = base === 'VAN-' ? 'VAN-1' : base;
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let n = 2; n < 10_000; n += 1) {
    const next = `${stem}-${String(n)}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return `${stem}-${String(Date.now())}`;
}

/** A reason for stopping, pausing or ending, in the person's own words. */
export function readReason(raw: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < REASON_LIMIT.min || reason.length > REASON_LIMIT.max) return { ok: false, error: `Say why, in ${String(REASON_LIMIT.min)} to ${String(REASON_LIMIT.max)} characters.` };
  return { ok: true, reason };
}

export type RepMode = 'van_sell' | 'pre_sell';
export const REP_MODES: readonly RepMode[] = ['van_sell', 'pre_sell'];
export const REP_MODE_WORDS: Record<RepMode, string> = { van_sell: 'Van sell', pre_sell: 'Pre-sell' };
export const REP_STATUSES = ['active', 'paused', 'ended'] as const;
export type RepStatus = (typeof REP_STATUSES)[number];
export const REP_STATUS_WORDS: Record<RepStatus, string> = { active: 'Selling', paused: 'Paused', ended: 'Ended' };
export const VAN_STATUS_WORDS = { active: 'In use', stopped: 'Stopped' } as const;

export interface RepInput {
  /** Who they are; only when adding (a rep's person never changes). */
  userId: string | null;
  phone: string | null;
  homeBranchId: string | null;
  modes: RepMode[];
  limits: RepLimits;
}

export type RepRead = { ok: true; rep: RepInput } | { ok: false; error: string };

const PHONE = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;

export function readRep(raw: unknown, adding: boolean): RepRead {
  if (!isRecord(raw)) return { ok: false, error: 'The sales rep could not be read.' };
  if (adding && !isId(raw.userId)) return { ok: false, error: 'Choose the person from the list of staff.' };
  const phoneText = typeof raw.phone === 'string' ? raw.phone.trim() : '';
  if (phoneText !== '' && !PHONE.test(phoneText)) return { ok: false, error: 'Give a phone number the customer and the office can call, such as +254 700 000 000.' };
  const branch = optionalId(raw.homeBranchId);
  if (!branch.ok) return { ok: false, error: 'Choose a branch from the list, or leave it empty.' };
  const modesRaw: unknown[] = Array.isArray(raw.modes) ? raw.modes : [];
  const modes = REP_MODES.filter((m) => modesRaw.includes(m));
  if (modes.length === 0 || modes.length !== modesRaw.length) return { ok: false, error: 'Choose what the rep does: van sell, pre-sell, or both.' };
  const limits = readLimits(raw.limits);
  if (!limits.ok) return limits;
  return { ok: true, rep: { userId: adding && isId(raw.userId) ? raw.userId : null, phone: phoneText === '' ? null : phoneText, homeBranchId: branch.id, modes, limits: limits.limits } };
}

/** What a rep does, in words. */
export const modesWords = (modes: readonly string[]): string => modes.map((m) => (REP_MODE_WORDS as Record<string, string>)[m] ?? m).join(' and ');
