/** How a fiscal year is cut into periods. Any shape is data; these are the built-in ones. */
export type CalendarShape = 'monthly' | 'weeks_445' | 'weeks_454' | 'weeks_544' | 'weeks_13x4';

export interface GeneratedPeriod {
  no: number;
  name: string;
  startsOn: string;
  endsOn: string;
}

const DAY = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  return toIso(toMs(iso) + days * DAY);
}

export function addMonths(iso: string, months: number): string {
  const d = new Date(toMs(iso));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return toIso(target.getTime());
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEK_PATTERNS: Record<Exclude<CalendarShape, 'monthly' | 'weeks_13x4'>, number[]> = {
  weeks_445: [4, 4, 5],
  weeks_454: [4, 5, 4],
  weeks_544: [5, 4, 4],
};

/**
 * Cuts the fiscal year that starts on `startsOn` into periods that are contiguous and cover
 * exactly one year (the last period of a week-based year absorbs any 53rd week or spare days).
 */
export function generatePeriods(startsOn: string, shape: CalendarShape): GeneratedPeriod[] {
  const yearEnd = addDays(addMonths(startsOn, 12), -1);
  if (shape === 'monthly') {
    return Array.from({ length: 12 }, (_, i) => {
      const from = addMonths(startsOn, i);
      const to = i === 11 ? yearEnd : addDays(addMonths(startsOn, i + 1), -1);
      const month = MONTHS[new Date(toMs(from)).getUTCMonth()] ?? '';
      return { no: i + 1, name: `${month} ${from.slice(0, 4)}`, startsOn: from, endsOn: to };
    });
  }
  const weeks =
    shape === 'weeks_13x4'
      ? Array.from({ length: 13 }, () => 4)
      : Array.from({ length: 12 }, (_, i) => WEEK_PATTERNS[shape][i % 3] ?? 4);
  const periods: GeneratedPeriod[] = [];
  let cursor = startsOn;
  weeks.forEach((w, i) => {
    const last = i === weeks.length - 1;
    const end = last ? yearEnd : addDays(cursor, w * 7 - 1);
    periods.push({ no: i + 1, name: `P${String(i + 1).padStart(2, '0')} ${startsOn.slice(0, 4)}`, startsOn: cursor, endsOn: end });
    cursor = addDays(end, 1);
  });
  return periods;
}

/** Problems with a set of periods that is meant to tile a fiscal year (empty = fine). */
export function checkPeriodsTile(periods: GeneratedPeriod[]): string[] {
  const problems: string[] = [];
  const sorted = [...periods].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  sorted.forEach((p, i) => {
    if (p.endsOn < p.startsOn) problems.push(`Period ${p.no} ends before it starts.`);
    const next = sorted[i + 1];
    if (next && addDays(p.endsOn, 1) !== next.startsOn) {
      problems.push(`There is a gap or overlap between period ${p.no} and period ${next.no}.`);
    }
  });
  return problems;
}
