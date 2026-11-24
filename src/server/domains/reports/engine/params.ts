import type { OverviewRequest } from '../service';

/**
 * Readers for what a browser sends. Nothing a browser sends is trusted: each reader keeps only a value of the right
 * shape and drops anything else, so a tampered or malformed request becomes "no value" and the report falls back to
 * its defaults instead of reaching a query.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value only if it is an id of the right shape. */
export function readUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day written YYYY-MM-DD that really exists (no 2026-02-30), or nothing. */
export function readYmd(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = YMD.exec(value);
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  const real =
    probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
  return real ? value : undefined;
}

/** The value only if it is one of the allowed words. */
export function readChoice<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' ? allowed.find((a) => a === value) : undefined;
}

/** A text cut to `max` characters, or nothing when it is not text. */
export function readShortText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

/** A plain object, or an empty one (arrays, null and everything else are not parameters). */
export function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * The Business Overview's parameters. The cleaning is exactly what the overview action always did (short texts for
 * the period and the dates, a well-formed id for the branch); the period resolver then decides what a short text
 * means and falls back to a default, with a notice, for anything it cannot read.
 */
export function readOverviewParams(raw: unknown): OverviewRequest {
  const input = asRecord(raw);
  return {
    preset: readShortText(input.preset, 20),
    compare: readShortText(input.compare, 20),
    from: readShortText(input.from, 10),
    to: readShortText(input.to, 10),
    branchId: readUuid(input.branchId),
  };
}
