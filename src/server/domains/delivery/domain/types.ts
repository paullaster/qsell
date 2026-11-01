/**
 * The vocabulary of delivery charges. Dependency-free, so the engine, the service, the schema and the screens share it.
 * See docs/architecture/delivery-module.md section 23. Money is in major units (shillings); distances in kilometres; weights in kilograms.
 */

export const CHARGE_METHODS = ['zone_rate', 'flat', 'distance'] as const;
export type ChargeMethod = (typeof CHARGE_METHODS)[number];

export const CHARGE_METHOD_WORDS: Record<ChargeMethod, { name: string; means: string }> = {
  zone_rate: { name: 'By zone', means: 'A fee for each delivery zone, optionally by weight.' },
  flat: { name: 'Flat or by weight', means: 'One fee everywhere, or a fee for each weight band.' },
  distance: { name: 'By distance', means: 'A fee that grows with the distance from the branch to the customer.' },
};

export const DISTANCE_BASES = ['one_way', 'longer_leg', 'round_trip'] as const;
export type DistanceBasis = (typeof DISTANCE_BASES)[number];

export const DISTANCE_BASIS_WORDS: Record<DistanceBasis, string> = {
  one_way: 'One way, branch to customer',
  longer_leg: 'The longer of going and coming back (roads can be one-way)',
  round_trip: 'There and back',
};

export const ROUND_MODES = ['nearest', 'up'] as const;
export type RoundMode = (typeof ROUND_MODES)[number];

/** A fee for a weight band, in one zone or (zoneId null) in any zone. `toKg` null is the open top band. */
export interface RateRow {
  zoneId: string | null;
  fromKg: number;
  toKg: number | null;
  fee: number;
  /** Charged for each started kilogram above `fromKg`; only on the open top band. */
  perExtraKg: number;
}

/** A stretch of distance. The fee is `baseFee` plus `perKm` for each kilometre past `fromKm`. `toKm` null is the open last band. */
export interface DistanceBand {
  fromKm: number;
  toKm: number | null;
  baseFee: number;
  perKm: number;
}

/** From this order value up, a percentage is taken off the delivery charge; 100 is free delivery. */
export interface ValueTier {
  minOrderValue: number;
  percentOff: number;
}

/**
 * An extra amount when the delivery falls in a time rule, in the company's time zone. Days are 0 (Sunday) to 6. The window of the day
 * is minutes from midnight and may cross midnight (from after to). The dates are "MM-DD" and may cross the new year.
 */
export interface Surcharge {
  label: string;
  kind: 'fixed' | 'percent';
  amount: number;
  days: number[] | null;
  fromMinute: number | null;
  toMinute: number | null;
  dateFrom: string | null;
  dateTo: string | null;
}

/** What a policy is, as the engine needs it. */
export interface ChargePolicyDef {
  id: string;
  code: string;
  name: string;
  version: number;
  method: ChargeMethod;
  currency: string;
  distanceBasis: DistanceBasis;
  maxRangeKm: number | null;
  /** Distance method: charged for each minute of travel when the route says how long it takes. */
  perMinute: number;
  /** Distance method: weight above this is charged `perExtraKg` for each started kilogram. */
  includedKg: number | null;
  perExtraKg: number;
  maxWeightKg: number | null;
  minCharge: number | null;
  maxCharge: number | null;
  /** The unit the final charge is rounded to (1 is whole shillings). */
  roundTo: number;
  roundMode: RoundMode;
  rates: RateRow[];
  bands: DistanceBand[];
  tiers: ValueTier[];
  surcharges: Surcharge[];
}

/** A leg of the trip as a map service reports it. */
export interface Leg {
  km: number;
  minutes: number | null;
}

export interface ChargeRequest {
  /** The moment of the delivery order; decides the time rules. Passed in, never read from the clock. */
  at: Date;
  /** The company's time zone, for example Africa/Nairobi. */
  timeZone: string;
  /** The zone the delivery goes to, or null when none was found. */
  zoneId: string | null;
  /** The zone's name, for the explanation. */
  zoneName?: string | null;
  /** Branch to customer. Null when there is no pin to measure from. */
  out: Leg | null;
  /** Customer back to the branch, when the map service gave it. */
  back: Leg | null;
  /** True when the distance was worked out from a geocoded written address, not a pin the customer set. */
  distanceApproximate: boolean;
  orderValue: number;
  weightKg: number;
}

export type RefusalReason = 'bad_input' | 'bad_time_zone' | 'no_zone' | 'no_distance' | 'out_of_range' | 'no_rate' | 'too_heavy';

export type StepKind = 'base' | 'time' | 'weight' | 'surcharge' | 'minimum' | 'maximum' | 'order_value' | 'rounding';

/** One line of the explanation of a charge. `amount` is the change this step made; `running` is the charge after it. */
export interface ChargeStep {
  kind: StepKind;
  label: string;
  amount: number;
  running: number;
}

export type ChargeQuote =
  | {
      ok: true;
      amount: number;
      currency: string;
      steps: ChargeStep[];
      /** What the charge was worked out from, so the quote can be shown and stored. */
      basis: { method: ChargeMethod; policyId: string; policyVersion: number; km: number | null; minutes: number | null; zoneId: string | null; approximate: boolean };
    }
  | { ok: false; reason: RefusalReason; message: string };
