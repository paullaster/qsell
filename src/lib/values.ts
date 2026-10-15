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
