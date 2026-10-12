export function formatMoney(amount: number, currency: string): string {
  const whole = Number.isInteger(amount) || Math.abs(amount) >= 1000;
  return `${currency} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** Short form for tiles and axes (KES 15.3K, KES 1.2M); the full amount belongs in a title/aria-label. */
export function formatMoneyShort(amount: number, currency: string): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000)
    return `${currency} ${(amount / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${currency} ${(amount / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return formatMoney(amount, currency);
}

export function formatCompact(amount: number): string {
  return new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: 1 }).format(
    amount,
  );
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-KE');
}

/** "15 Oct 2026" from a YYYY-MM-DD local date, without any timezone shifting. */
export function formatLocalDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-KE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateRange(fromDate: string, toDate: string): string {
  return fromDate === toDate
    ? formatLocalDate(fromDate)
    : `${formatLocalDate(fromDate)} – ${formatLocalDate(toDate)}`;
}

export function formatInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-KE', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
