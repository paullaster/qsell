import { isRecord } from '@/lib/values';
import { formatBusinessTime } from '@/server/kernel/numbering/business-date';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const day = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${iso}T00:00:00Z`));

/**
 * What a downloaded report says it covers: the days of its period, or "As at ..." for a report of a position, and the
 * branch or locations it was run for. Read from the facts the report itself carries, so the file never states one thing
 * while the screen shows another. A report that carries none is described by the time it was produced.
 */
export function coverageOf(
  data: unknown,
  producedAt: string,
  timeZone: string,
): { period: string; scope: string } {
  const facts = isRecord(data) && isRecord(data.facts) ? data.facts : null;
  const scope = typeof facts?.scopeLabel === 'string' ? facts.scopeLabel : '';
  const from = facts?.fromDate;
  const to = facts?.toDate;
  const asAt = `As at ${formatBusinessTime(new Date(producedAt), timeZone)}`;
  if (facts === null || facts.asAtNow === true) return { period: asAt, scope };
  if (typeof from !== 'string' || typeof to !== 'string' || !ISO_DAY.test(from) || !ISO_DAY.test(to)) {
    return { period: asAt, scope };
  }
  return { period: from === to ? day(from) : `${day(from)} to ${day(to)}`, scope };
}
