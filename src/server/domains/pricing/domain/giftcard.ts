import type { RuleIssue } from './rules';

/** No 0, O, 1, I or L: codes get read out over the phone and typed from a printed card. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MAX_GIFT_CARD_VALUE = 1_000_000;
export const MAX_CARDS_PER_BATCH = 500;

/** A code of 16 characters in four groups, drawn from `random` (a function giving 0..n-1). */
export function generateGiftCardCode(randomInt: (n: number) => number): string {
  const chars = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]!);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/** Spaces, dashes and case do not matter when a code is typed. */
export const normaliseGiftCardCode = (raw: string): string =>
  raw
    .replace(/[\s-]+/g, '')
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-');

export function checkGiftCardIssue(
  i: {
    value: number;
    expiresAt: Date | null;
    count?: number;
  },
  now: Date = new Date(),
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (!(i.value > 0) || i.value > MAX_GIFT_CARD_VALUE)
    issues.push({
      path: 'value',
      message: `A card is worth more than 0 and at most ${MAX_GIFT_CARD_VALUE.toLocaleString()}.`,
    });
  if (
    Math.round(i.value * 100) !== i.value * 100 &&
    Math.abs(Math.round(i.value * 100) - i.value * 100) > 1e-6
  )
    issues.push({ path: 'value', message: 'Use at most two decimals.' });
  if (i.expiresAt && i.expiresAt <= now)
    issues.push({ path: 'expiresAt', message: 'The expiry must be in the future.' });
  if (
    i.count != null &&
    (!Number.isInteger(i.count) || i.count < 1 || i.count > MAX_CARDS_PER_BATCH)
  )
    issues.push({
      path: 'count',
      message: `Issue between 1 and ${MAX_CARDS_PER_BATCH} cards at a time.`,
    });
  return issues;
}

/** How much of a card goes against what is still to pay. */
export const giftCardApplies = (balance: number, due: number): number =>
  Math.max(0, Math.round(Math.min(balance, due) * 100) / 100);
