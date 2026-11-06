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
