/**
 * Small, pure helpers for values that may be missing or empty. They exist so that a check reads as
 * what it means ("has something in it", "or else this") instead of leaning on truthiness, and so
 * that data that arrives loosely typed (saved JSON, provider replies) is read in one careful place.
 */

/** True for a text that has something in it. It also tells the compiler the value is a string from then on. */
export const has = (value: string | null | undefined): value is string => value !== null && value !== undefined && value !== '';

/** The text, or null when there is none. */
export const emptyToNull = (value: string | null | undefined): string | null => (has(value) ? value : null);

/** The text without surrounding spaces, or null when nothing is left. */
export const trimToNull = (value: string | null | undefined): string | null => emptyToNull(value?.trim());

/** The first of these that has something in it, or null. */
export function firstFilled(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) if (has(value)) return value;
  return null;
}

/** The text when it has something in it, else the fallback. */
export function orElse<T>(value: string | null | undefined, fallback: T): string | T {
  return has(value) ? value : fallback;
}

/** The value, or an error that says what was expected. For places where a missing value is a bug, not a case. */
export function required<T>(value: T | null | undefined, what = 'a value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}, but there was none.`);
  return value;
}

/** The item at this position, or an error that says so. */
export function nth<T>(items: readonly T[], index: number): T {
  return required(items.at(index), `an item at position ${String(index)}`);
}

/** The first usable text among these: a non-empty string, or a number written out. Anything else is skipped. */
export function readText(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'bigint') return value.toString();
  }
  return '';
}

/** True for a plain object (not null, not a list). */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The object, or an empty one when the value is anything else (loose JSON read safely). */
export const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** One item or many (as XML-turned-JSON delivers them) as a list; nothing as an empty list. */
export function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

/** The first of these differences that is not zero, so a sort can fall back from one key to the next. */
export const firstNonZero = (...differences: readonly number[]): number => differences.find((d) => d !== 0) ?? 0;

/** -1, 0 or 1 for how two texts (or numbers) order. */
export function compareValues(a: string | number, b: string | number): -1 | 0 | 1 {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The text fields of an object that have something in them, trimmed. Anything else is dropped. */
export function filledStrings(record: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}
