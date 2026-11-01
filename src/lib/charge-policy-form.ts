import type { Choice } from '@/lib/payment-options';
import { clockText } from '@/lib/clock-time';
import type { ChargeMethod, ChargePolicyDef, DistanceBasis, RoundMode } from '@/server/domains/delivery/domain/types';

/** The editor's fields as text, the way people type them. `payloadFromForm` turns them into what the server reads. */

export type ScopeDimensionKey = 'branch' | 'customer_group' | 'channel';
export const SCOPE_KEYS: readonly ScopeDimensionKey[] = ['branch', 'customer_group', 'channel'];

export interface ScopeLine {
  op: 'in' | 'not_in';
  /** The chosen ids with the words to show for them. */
  chosen: Choice[];
}

export interface RateLine {
  /** Tells the rows of a list apart on the screen; not sent. */
  key: string;
  zone: Choice | null;
  fromKg: string;
  toKg: string;
  fee: string;
  perExtraKg: string;
}

export interface BandLine {
  /** Tells the rows of a list apart on the screen; not sent. */
  key: string;
  fromKm: string;
  toKm: string;
  baseFee: string;
  perKm: string;
}

export interface TierLine {
  /** Tells the rows of a list apart on the screen; not sent. */
  key: string;
  minOrderValue: string;
  percentOff: string;
}

export interface SurchargeLine {
  /** Tells the rows of a list apart on the screen; not sent. */
  key: string;
  label: string;
  kind: 'fixed' | 'percent';
  amount: string;
  /** Sunday to Saturday; all off means every day. */
  days: boolean[];
  hoursOn: boolean;
  from: string;
  to: string;
  seasonOn: boolean;
  dateFrom: string;
  dateTo: string;
}

export interface PolicyForm {
  code: string;
  name: string;
  description: string;
  method: ChargeMethod;
  currency: string;
  priority: string;
  firstDay: string;
  lastDay: string;
  scopes: Partial<Record<ScopeDimensionKey, ScopeLine>>;
  distanceBasis: DistanceBasis;
  maxRangeKm: string;
  perMinute: string;
  includedKg: string;
  perExtraKg: string;
  maxWeightKg: string;
  minCharge: string;
  maxCharge: string;
  roundTo: string;
  roundMode: RoundMode;
  rates: RateLine[];
  bands: BandLine[];
  tiers: TierLine[];
  surcharges: SurchargeLine[];
}

/** A key no row in the list has yet. */
export const nextKey = (rows: readonly { key: string }[]): string => String(rows.reduce((max, r) => Math.max(max, Number(r.key) + 1), 0));

export const emptyRate = (key = '0'): RateLine => ({ key, zone: null, fromKg: '0', toKg: '', fee: '', perExtraKg: '' });
export const emptyBand = (fromKm = '0', key = '0'): BandLine => ({ key, fromKm, toKm: '', baseFee: '', perKm: '' });
export const emptyTier = (key = '0'): TierLine => ({ key, minOrderValue: '', percentOff: '' });
export const emptySurcharge = (key = '0'): SurchargeLine => ({ key, label: '', kind: 'fixed', amount: '', days: new Array<boolean>(7).fill(false), hoursOn: false, from: '22:00', to: '06:00', seasonOn: false, dateFrom: '12-01', dateTo: '01-05' });

export const emptyPolicyForm = (currency = 'KES'): PolicyForm => ({
  code: '', name: '', description: '', method: 'flat', currency, priority: '0', firstDay: '', lastDay: '', scopes: {}, distanceBasis: 'one_way', maxRangeKm: '', perMinute: '', includedKg: '', perExtraKg: '', maxWeightKg: '', minCharge: '', maxCharge: '', roundTo: '', roundMode: 'nearest',
  rates: [{ ...emptyRate() }], bands: [emptyBand()], tiers: [], surcharges: [],
});

const show = (n: number | null): string => (n === null ? '' : String(n));

/** The form for a policy that exists, with the words for the zones and who it is for. */
export function formFromPolicy(
  policy: { code: string; description: string | null; priority: number; firstDay: string; lastDay: string | null; scopes: Record<string, { op: 'in' | 'not_in'; values: string[] }>; def: ChargePolicyDef },
  names: { zones: Record<string, string>; scopes: Record<string, Record<string, string>> },
): PolicyForm {
  const d = policy.def;
  const scopes: PolicyForm['scopes'] = {};
  for (const key of SCOPE_KEYS) {
    const rule = policy.scopes[key];
    if (rule !== undefined && rule.values.length > 0) scopes[key] = { op: rule.op, chosen: rule.values.map((id) => ({ id, label: names.scopes[key]?.[id] ?? id })) };
  }
  return {
    code: policy.code,
    name: d.name,
    description: policy.description ?? '',
    method: d.method,
    currency: d.currency,
    priority: String(policy.priority),
    firstDay: policy.firstDay,
    lastDay: policy.lastDay ?? '',
    scopes,
    distanceBasis: d.distanceBasis,
    maxRangeKm: show(d.maxRangeKm),
    perMinute: d.perMinute === 0 ? '' : String(d.perMinute),
    includedKg: show(d.includedKg),
    perExtraKg: d.perExtraKg === 0 ? '' : String(d.perExtraKg),
    maxWeightKg: show(d.maxWeightKg),
    minCharge: show(d.minCharge),
    maxCharge: show(d.maxCharge),
    roundTo: d.roundTo === 0 ? '' : String(d.roundTo),
    roundMode: d.roundMode,
    rates: d.rates.map((r, i) => ({ key: String(i), zone: r.zoneId === null ? null : { id: r.zoneId, label: names.zones[r.zoneId] ?? r.zoneId }, fromKg: String(r.fromKg), toKg: show(r.toKg), fee: String(r.fee), perExtraKg: r.perExtraKg === 0 ? '' : String(r.perExtraKg) })),
    bands: d.bands.map((b, i) => ({ key: String(i), fromKm: String(b.fromKm), toKm: show(b.toKm), baseFee: String(b.baseFee), perKm: b.perKm === 0 ? '' : String(b.perKm) })),
    tiers: d.tiers.map((t, i) => ({ key: String(i), minOrderValue: String(t.minOrderValue), percentOff: String(t.percentOff) })),
    surcharges: d.surcharges.map((s, i) => ({
      key: String(i),
      label: s.label,
      kind: s.kind,
      amount: String(s.amount),
      days: Array.from({ length: 7 }, (_, day) => s.days?.includes(day) ?? false),
      hoursOn: s.fromMinute !== null && s.toMinute !== null,
      from: s.fromMinute === null ? '22:00' : clockText(s.fromMinute),
      to: s.toMinute === null ? '06:00' : clockText(s.toMinute),
      seasonOn: s.dateFrom !== null && s.dateTo !== null,
      dateFrom: s.dateFrom ?? '12-01',
      dateTo: s.dateTo ?? '01-05',
    })),
  };
}

/** What the server action reads. Blank fields are sent blank; the server decides what they mean and checks them. */
export function payloadFromForm(f: PolicyForm): Record<string, unknown> {
  const scopes: Record<string, { op: string; values: string[] }> = {};
  for (const key of SCOPE_KEYS) {
    const line = f.scopes[key];
    if (line !== undefined) scopes[key] = { op: line.op, values: line.chosen.map((c) => c.id) };
  }
  const distance = f.method === 'distance';
  return {
    name: f.name,
    description: f.description,
    method: f.method,
    currency: f.currency,
    priority: f.priority,
    validFrom: f.firstDay,
    validTo: f.lastDay,
    scopes,
    distanceBasis: f.distanceBasis,
    maxRangeKm: distance ? f.maxRangeKm : '',
    perMinute: distance ? f.perMinute : '',
    includedKg: distance ? f.includedKg : '',
    perExtraKg: distance ? f.perExtraKg : '',
    maxWeightKg: f.maxWeightKg,
    minCharge: f.minCharge,
    maxCharge: f.maxCharge,
    roundTo: f.roundTo,
    roundMode: f.roundMode,
    rates: distance ? [] : f.rates.map((r) => ({ zoneId: f.method === 'flat' ? '' : (r.zone?.id ?? ''), fromKg: r.fromKg, toKg: r.toKg, fee: r.fee, perExtraKg: r.perExtraKg })),
    bands: distance ? f.bands.map((b) => ({ fromKm: b.fromKm, toKm: b.toKm, baseFee: b.baseFee, perKm: b.perKm })) : [],
    tiers: f.tiers.map((t) => ({ minOrderValue: t.minOrderValue, percentOff: t.percentOff })),
    surcharges: f.surcharges.map((s) => {
      const days = s.days.flatMap((on, day) => (on ? [day] : []));
      return {
        label: s.label,
        kind: s.kind,
        amount: s.amount,
        days: days.length === 0 ? null : days,
        fromMinute: s.hoursOn ? s.from : null,
        toMinute: s.hoursOn ? s.to : null,
        dateFrom: s.seasonOn ? s.dateFrom : null,
        dateTo: s.seasonOn ? s.dateTo : null,
      };
    }),
  };
}
