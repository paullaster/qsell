import { DEFAULT_BUSINESS_TIMEZONE } from '@/server/kernel/numbering/business-date';

export const PERIOD_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'custom',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  this_year: 'This year',
  custom: 'Custom range',
};

/** Longest custom range, so one request can never ask the database for years of data. */
export const MAX_CUSTOM_DAYS = 366;

export const COMPARE_MODES = ['previous_period', 'previous_year'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export const COMPARE_LABELS: Record<CompareMode, string> = {
  previous_period: 'Previous period',
  previous_year: 'Same period last year',
};

export interface PeriodInput {
  preset?: string;
  compare?: string;
  /** Inclusive local dates (YYYY-MM-DD), custom range only. */
  from?: string;
  to?: string;
}

export interface TimeWindow {
  /** Inclusive start, UTC instant. */
  from: Date;
  /** Exclusive end, UTC instant. */
  to: Date;
  /** First and last local calendar day covered (inclusive), in the business timezone. */
  fromDate: string;
  toDate: string;
}

export interface ResolvedPeriod extends TimeWindow {
  preset: PeriodPreset;
  compare: CompareMode;
  label: string;
  timeZone: string;
  /** Local calendar days in the window, oldest first (for zero-filled trends). */
  days: string[];
  /**
   * The like-for-like window before this one. If the current period is still running, the
   * previous window is cut at the same elapsed time, so "today so far" is not compared with a
   * whole day.
   */
  previous: TimeWindow;
  /** Set when the requested range was invalid and a default was used. */
  notice: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parseYmd(value: string): Ymd | null {
  if (!DATE_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

function fmtYmd({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(ymd: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d) + days * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function diffDays(a: Ymd, b: Ymd): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** A local calendar date moved by a number of days (YYYY-MM-DD in, YYYY-MM-DD out). */
export function shiftDate(date: string, days: number): string {
  const ymd = parseYmd(date);
  return ymd ? fmtYmd(addDays(ymd, days)) : date;
}

/** `count` consecutive local calendar days starting at `fromDate` (YYYY-MM-DD). */
export function listDays(fromDate: string, count: number): string[] {
  const start = parseYmd(fromDate);
  if (!start) return [];
  return Array.from({ length: count }, (_, i) => fmtYmd(addDays(start, i)));
}

/** The local calendar date of an instant in a timezone. */
export function localYmd(instant: Date, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Offset (ms) of a timezone from UTC at a given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which a local calendar day starts in a timezone. */
export function startOfLocalDay(ymd: Ymd, timeZone: string): Date {
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d);
  let t = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Re-evaluate once so a daylight-saving jump between guess and result is absorbed.
  t = guess - zoneOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

interface Span {
  startDay: Ymd;
  /** Exclusive end day. */
  endDay: Ymd;
  prevStartDay: Ymd;
  label: string;
  preset: PeriodPreset;
  notice: string | null;
}

function monthStart(ymd: Ymd): Ymd {
  return { y: ymd.y, m: ymd.m, d: 1 };
}

/** Same month/day in another year; 29 Feb becomes 28 Feb when the target year has no leap day. */
function shiftYear(ymd: Ymd, years: number): Ymd {
  const y = ymd.y + years;
  const lastDay = new Date(Date.UTC(y, ymd.m, 0)).getUTCDate();
  return { y, m: ymd.m, d: Math.min(ymd.d, lastDay) };
}

function addMonths(ymd: Ymd, months: number): Ymd {
  const index = ymd.y * 12 + (ymd.m - 1) + months;
  return { y: Math.floor(index / 12), m: (index % 12) + 1, d: 1 };
}

function spanFor(input: PeriodInput, today: Ymd): Span {
  const preset = (PERIOD_PRESETS as readonly string[]).includes(input.preset ?? '')
    ? (input.preset as PeriodPreset)
    : 'last_30_days';
  const fixed = (
    p: PeriodPreset,
    startDay: Ymd,
    endDay: Ymd,
    prevStartDay: Ymd,
    notice: string | null = null,
  ): Span => ({
    startDay,
    endDay,
    prevStartDay,
    label: PERIOD_PRESET_LABELS[p],
    preset: p,
    notice,
  });
  const tomorrow = addDays(today, 1);

  switch (preset) {
    case 'today':
      return fixed('today', today, tomorrow, addDays(today, -1));
    case 'yesterday':
      return fixed('yesterday', addDays(today, -1), today, addDays(today, -2));
    case 'last_7_days':
      return fixed('last_7_days', addDays(today, -6), tomorrow, addDays(today, -13));
    case 'this_month': {
      const start = monthStart(today);
      return fixed('this_month', start, tomorrow, addMonths(start, -1));
    }
    case 'last_month': {
      const start = addMonths(monthStart(today), -1);
      return fixed('last_month', start, monthStart(today), addMonths(start, -1));
    }
    case 'this_quarter': {
      const start = { y: today.y, m: today.m - ((today.m - 1) % 3), d: 1 };
      return fixed('this_quarter', start, tomorrow, addMonths(start, -3));
    }
    case 'this_year': {
      const start = { y: today.y, m: 1, d: 1 };
      return fixed('this_year', start, tomorrow, addMonths(start, -12));
    }
    case 'custom': {
      const from = parseYmd(input.from ?? '');
      const to = parseYmd(input.to ?? '');
      if (from && to) {
        const lastDay = diffDays(today, to) > 0 ? today : to; // never report the future
        const length = diffDays(from, lastDay) + 1;
        if (length >= 1 && length <= MAX_CUSTOM_DAYS) {
          return fixed('custom', from, addDays(lastDay, 1), addDays(from, -length));
        }
      }
      const fallback = fixed('last_30_days', addDays(today, -29), tomorrow, addDays(today, -59));
      return {
        ...fallback,
        notice: `The custom range was not valid (use dates up to ${MAX_CUSTOM_DAYS} days apart, start before end). Showing the last 30 days instead.`,
      };
    }
    case 'last_30_days':
    default:
      return fixed('last_30_days', addDays(today, -29), tomorrow, addDays(today, -59));
  }
}

/**
 * Turn a period request into exact UTC windows. Everything downstream (queries, cache keys,
 * the "how this was calculated" panel) uses these bounds, so the same input and the same
 * `now` always reproduce the same numbers.
 */
export function resolvePeriod(
  input: PeriodInput,
  now: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): ResolvedPeriod {
  const today = localYmd(now, timeZone);
  const span = spanFor(input, today);

  const from = startOfLocalDay(span.startDay, timeZone);
  const to = startOfLocalDay(span.endDay, timeZone);

  // Like-for-like: if the window is still running, only compare the elapsed part.
  const elapsedMs = Math.min(to.getTime(), now.getTime()) - from.getTime();
  const compare: CompareMode =
    input.compare === 'previous_year' ? 'previous_year' : 'previous_period';
  const prevStartDay =
    compare === 'previous_year' ? shiftYear(span.startDay, -1) : span.prevStartDay;
  const prevFrom = startOfLocalDay(prevStartDay, timeZone);
  const prevEndDay =
    compare === 'previous_year'
      ? shiftYear(span.endDay, -1)
      : span.preset === 'this_month' || span.preset === 'last_month'
        ? addMonths(span.prevStartDay, 1)
        : span.preset === 'this_quarter'
          ? addMonths(span.prevStartDay, 3)
          : span.preset === 'this_year'
            ? addMonths(span.prevStartDay, 12)
            : addDays(span.prevStartDay, diffDays(span.startDay, span.endDay));
  const prevNaturalEnd = startOfLocalDay(prevEndDay, timeZone);
  const running = now.getTime() < to.getTime();
  const prevTo = running
    ? new Date(Math.min(prevNaturalEnd.getTime(), prevFrom.getTime() + Math.max(elapsedMs, 0)))
    : prevNaturalEnd;

  const dayCount = diffDays(span.startDay, span.endDay);
  const days = Array.from({ length: dayCount }, (_, i) => fmtYmd(addDays(span.startDay, i)));
  const lastDay = addDays(span.endDay, -1);
  const prevLastMs = Math.max(prevTo.getTime() - 1, prevFrom.getTime());

  return {
    preset: span.preset,
    compare,
    label: span.label,
    timeZone,
    from,
    to,
    fromDate: fmtYmd(span.startDay),
    toDate: fmtYmd(lastDay),
    days,
    previous: {
      from: prevFrom,
      to: prevTo,
      fromDate: fmtYmd(prevStartDay),
      toDate: fmtYmd(localYmd(new Date(prevLastMs), timeZone)),
    },
    notice: span.notice,
  };
}
