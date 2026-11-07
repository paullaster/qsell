/**
 * What delivery costs the company: rider pay earned, what a courier charged, anything else. Pure rules: the kinds, how much a rider earns,
 * the key that makes each cost happen once, and how a cost is taken back. The database and screens follow them.
 */

export const COST_KINDS = ['rider_delivery', 'rider_day', 'courier', 'other'] as const;
export type CostKind = (typeof COST_KINDS)[number];
export const isCostKind = (value: unknown): value is CostKind => typeof value === 'string' && (COST_KINDS as readonly string[]).includes(value);

export const COST_WORDS: Record<CostKind, string> = {
  rider_delivery: 'Rider pay for a delivery',
  rider_day: 'Rider pay for a day on a run',
  courier: 'Courier charge',
  other: 'Other cost',
};

export interface PayRules {
  perDelivery: number;
  perDay: number;
}

const cents = (n: number): number => Math.round(n * 100);
export const money = (c: number): string => (c / 100).toFixed(2);

/** The pay rules as typed: each a whole amount of money, more than or equal to nothing. Null with the words when they are not. */
export function readPayRules(perDelivery: unknown, perDay: unknown): { ok: true; rules: PayRules } | { ok: false; error: string } {
  for (const [value, what] of [[perDelivery, 'for each delivery'], [perDay, 'for each day']] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) return { ok: false, error: `Say what a rider earns ${what}, in shillings (nothing is fine).` };
  }
  return { ok: true, rules: { perDelivery: cents(perDelivery as number) / 100, perDay: cents(perDay as number) / 100 } };
}

/** The key that makes a rider's pay for one delivery happen once, and for one rider's day happen once however many runs they work. */
export const deliveryPayKey = (deliveryId: string): string => `rider_delivery:${deliveryId}`;
export const dayPayKey = (riderId: string, runDate: string): string => `rider_day:${riderId}:${runDate}`;
export const reversalKey = (costId: string): string => `reverse:${costId}`;

/** What a courier charged, as typed: more than nothing, to the cent. */
export function courierChargeProblem(amount: unknown): { error: string } | { cents: number } {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return { error: 'Say what the courier charged, in shillings.' };
  return { cents: cents(amount) };
}

export interface CostLine {
  kind: CostKind;
  cents: number;
}

/** The total of costs, reversals included (they carry the opposite sign). */
export const totalCents = (lines: readonly { cents: number }[]): number => lines.reduce((n, l) => n + l.cents, 0);

/** Costs added up by kind. */
export function byKind(lines: readonly CostLine[]): Record<CostKind, number> {
  const out: Record<CostKind, number> = { rider_delivery: 0, rider_day: 0, courier: 0, other: 0 };
  for (const l of lines) out[l.kind] += l.cents;
  return out;
}

// ── The books ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PAYS_RIDERS: readonly CostKind[] = ['rider_delivery', 'rider_day'];
/** Whether a cost is rider pay (the only kind posted and paid out here: a courier is paid on their supplier invoice). */
export const isRiderPay = (kind: CostKind): boolean => PAYS_RIDERS.includes(kind);

export interface PostingLine {
  side: 'debit' | 'credit';
  account: 'expense' | 'payable';
  cents: number;
}

/** The books' lines for one rider-pay entry: pay earned is a cost owed to the rider; a reversal takes it back the other way. */
export function costPostingLines(amountCents: number): PostingLine[] {
  const c = Math.abs(amountCents);
  if (amountCents > 0) return [{ side: 'debit', account: 'expense', cents: c }, { side: 'credit', account: 'payable', cents: c }];
  return [{ side: 'debit', account: 'payable', cents: c }, { side: 'credit', account: 'expense', cents: c }];
}

/** The books' lines for paying a rider: what is owed to them is cleared, and the till or bank pays it. */
export const payoutPostingLines = (cents: number): { side: 'debit' | 'credit'; account: 'payable' | 'bank'; cents: number }[] => [
  { side: 'debit', account: 'payable', cents },
  { side: 'credit', account: 'bank', cents },
];

/** The ways a rider can be paid: cash, mobile money, or the bank. */
export const PAYOUT_METHOD_KINDS = ['cash', 'mobile_money', 'bank_transfer', 'bank_deposit'] as const;
export const isPayoutMethodKind = (kind: string): boolean => (PAYOUT_METHOD_KINDS as readonly string[]).includes(kind);

/** A payout takes in everything owed to the rider (earned pay and anything taken back). Nothing owed, or less than nothing, cannot be paid out. */
export function payoutProblem(owedCents: number, entries: number): string | null {
  if (entries === 0) return 'Nothing is owed to this rider.';
  if (owedCents <= 0) return owedCents === 0 ? 'What this rider earned and what was taken back come to nothing, so there is nothing to pay.' : 'More was taken back than this rider earned, so there is nothing to pay. It is set against their next pay.';
  return null;
}

/** The wait after a failed posting: a minute, two, four ... up to an hour. */
export const retryAfterSeconds = (attempts: number): number => Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1));

// ── Reports ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What delivery earned less what it cost, in cents: negative means delivery lost money in the period. */
export const marginCents = (chargeCents: number, costCents: number): number => chargeCents - costCents;

/** A share of a whole as a whole percent, or null when there is no whole to take a share of. */
export const sharePercent = (part: number, whole: number): number | null => (whole <= 0 ? null : Math.round((part / whole) * 100));

export interface ReportPeriod {
  from: string;
  to: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The days a report covers: the two days typed (the first not after the second), or the last 30 days ending today. */
export function readPeriod(from: unknown, to: unknown, today: string): { ok: true; period: ReportPeriod } | { ok: false; error: string } {
  const end = typeof to === 'string' && DAY.test(to) ? to : today;
  let start = typeof from === 'string' && DAY.test(from) ? from : null;
  if (start === null) {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 29);
    start = d.toISOString().slice(0, 10);
  }
  if (start > end) return { ok: false, error: 'The first day cannot be after the last.' };
  const span = (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000;
  if (span > 366) return { ok: false, error: 'A report covers at most a year.' };
  return { ok: true, period: { from: start, to: end } };
}
