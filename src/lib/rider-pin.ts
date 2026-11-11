/**
 * Signing in to the rider app with a phone number and a PIN. Pure rules: the phone number as one canonical string, what a PIN may be,
 * the PIN the office hands out, and how long a rider is shut out after wrong tries. The database and the sign-in follow them.
 */

export const PIN_LENGTH = 6;
/** Wrong tries in a row before the rider is shut out for a while. */
export const LOCK_AFTER = 5;
const FIRST_LOCK_MINUTES = 15;
const LONGEST_LOCK_MINUTES = 240;

/**
 * A Kenyan mobile number as 254 and nine digits ("0712 345 678", "+254712345678", "712345678" all give 254712345678), or null when it is
 * not one. Numbers from other countries are refused: the rider app is used with Kenyan lines.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[^\d]/g, '');
  let national: string;
  if (digits.startsWith('254') && digits.length === 12) national = digits.slice(3);
  else if (digits.startsWith('0') && digits.length === 10) national = digits.slice(1);
  else if (digits.length === 9) national = digits;
  else return null;
  return /^[17]\d{8}$/.test(national) ? `254${national}` : null;
}

/** The number as a person reads it: 0712 345 678. */
export const phoneWords = (normalized: string): string => `0${normalized.slice(3, 6)} ${normalized.slice(6, 9)} ${normalized.slice(9, 12)}`;

const SHAPE = new RegExp(`^\\d{${String(PIN_LENGTH)}}$`);
/** Whether this is six digits and nothing else (not whether it is a good PIN). */
export const isPinShape = (value: unknown): value is string => typeof value === 'string' && SHAPE.test(value);
const COMMON = new Set(['123456', '654321', '111111', '000000', '121212', '123123', '112233', '696969', '159753', '147258', '102030', '123321', '010203', '200000', '202020']);

/** Why a PIN is refused, in words, or null when it will do: six digits, not a run or a repeat or a favourite, and not the end of the rider's own number. */
export function pinProblem(pin: unknown, phone: string | null = null): string | null {
  if (typeof pin !== 'string' || !SHAPE.test(pin)) return `A PIN is ${String(PIN_LENGTH)} digits, nothing else.`;
  const d = pin.split('').map(Number);
  if (d.every((x) => x === d[0])) return 'Choose a PIN that is not one digit repeated.';
  const steps = d.slice(1).map((x, i) => x - (d[i] ?? 0));
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'Choose a PIN that is not digits in a row, like 123456.';
  if (COMMON.has(pin)) return 'That PIN is too easy to guess. Choose another.';
  if (phone?.endsWith(pin) === true) return 'Do not use the end of your phone number as your PIN.';
  return null;
}

/** A PIN for the office to hand out: six random digits that pass the rules. `random` gives a number from 0 up to but not including its argument. */
export function generatePin(random: (below: number) => number, phone: string | null = null): string {
  for (let i = 0; i < 200; i += 1) {
    const pin = Array.from({ length: PIN_LENGTH }, () => String(random(10))).join('');
    if (pinProblem(pin, phone) === null) return pin;
  }
  return '482915';
}

/**
 * When a rider who has just got a PIN wrong may try again: nothing until the fifth wrong try in a row, then 15 minutes, doubling with each
 * further wrong try up to four hours. Null while they may still try.
 */
export function lockedUntil(failedInARow: number, now: Date): Date | null {
  if (failedInARow < LOCK_AFTER) return null;
  const minutes = Math.min(LONGEST_LOCK_MINUTES, FIRST_LOCK_MINUTES * 2 ** (failedInARow - LOCK_AFTER));
  return new Date(now.getTime() + minutes * 60_000);
}

/** Tries left before the lock, for the words under the form. */
export const triesLeft = (failedInARow: number): number => Math.max(0, LOCK_AFTER - failedInARow);

/** How long a lock still has to run, in words. */
export function lockWords(until: Date, now: Date): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h)} ${h === 1 ? 'hour' : 'hours'}${m > 0 ? ` ${String(m)} min` : ''}`;
}
