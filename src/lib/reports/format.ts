/**
 * How numbers, money, percentages and dates are written in reports. One place, so a figure looks the same on the
 * overview, in a table, in a chart label, in an export and in an email.
 *
 * The locale is a parameter (default: Kenya's English) and the time zone is always passed in, never read from the
 * browser: the same report must read the same on every machine. The functions are pure.
 */

export const DEFAULT_LOCALE = 'en-KE';

export function formatMoney(
  amount: number,
  currency: string,
  locale: string = DEFAULT_LOCALE,
): string {
  const whole = Number.isInteger(amount) || Math.abs(amount) >= 1000;
  return `${currency} ${amount.toLocaleString(locale, {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** Short form for tiles and axes (KES 15.3K, KES 1.2M); the full amount belongs in a title or an aria-label. */
export function formatMoneyShort(
  amount: number,
  currency: string,
  locale: string = DEFAULT_LOCALE,
): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000)
    return `${currency} ${(amount / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${currency} ${(amount / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return formatMoney(amount, currency, locale);
}

export function formatCompact(amount: number, locale: string = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    amount,
  );
}

export function formatCount(n: number, locale: string = DEFAULT_LOCALE): string {
  return n.toLocaleString(locale);
}

/** "12.4%" (digits default to one, trailing zero kept so a column lines up). */
export function formatPercent(value: number, digits = 1, locale: string = DEFAULT_LOCALE): string {
  return `${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export type Direction = 'up' | 'down' | 'flat';

export interface Delta {
  direction: Direction;
  /** Absolute percentage, already rounded the way it is shown; null when there is nothing to compare with. */
  percent: number | null;
}

/**
 * The change between two figures as a direction and a percentage. A zero or missing base gives `percent: null`
 * ("nothing to compare with") instead of a nonsense infinity; equal figures are `flat`.
 */
export function deltaOf(current: number, previous: number): Delta {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    if (current === previous) return { direction: 'flat', percent: null };
    return { direction: current > previous ? 'up' : 'down', percent: null };
  }
  const pct = Math.round(((current - previous) / previous) * 1000) / 10;
  if (pct === 0) return { direction: 'flat', percent: 0 };
  return { direction: pct > 0 ? 'up' : 'down', percent: Math.abs(pct) };
}

/** Sign for a variance, written with the real minus sign so it cannot be mistaken for a hyphen; empty for zero. */
export function signOf(value: number): '+' | '−' | '' {
  if (value > 0) return '+';
  if (value < 0) return '−';
  return '';
}

/** "15 Oct 2026" from a YYYY-MM-DD local date, without any time-zone shifting. */
export function formatLocalDate(ymd: string, locale: string = DEFAULT_LOCALE): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateRange(
  fromDate: string,
  toDate: string,
  locale: string = DEFAULT_LOCALE,
): string {
  return fromDate === toDate
    ? formatLocalDate(fromDate, locale)
    : `${formatLocalDate(fromDate, locale)} – ${formatLocalDate(toDate, locale)}`;
}

/** "15 Oct, 14:05" for an instant, in the business time zone given. */
export function formatInstant(
  iso: string,
  timeZone: string,
  locale: string = DEFAULT_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
