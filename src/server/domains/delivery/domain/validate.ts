import { CHARGE_METHODS, DISTANCE_BASES, ROUND_MODES, type ChargePolicyDef, type DistanceBand, type RateRow } from './types';

export interface Issue {
  path: string;
  message: string;
}

export const LIMITS = { rates: 5000, bands: 20, tiers: 20, surcharges: 20, money: 1_000_000_000 } as const;

const isMoney = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= LIMITS.money;
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const multipleOf = (value: number, unit: number): boolean => Math.abs(value / unit - Math.round(value / unit)) < 1e-9;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function isMonthDay(text: string | null): boolean {
  if (text === null) return false;
  const m = /^(\d{2})-(\d{2})$/.exec(text);
  if (m === null) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= (DAYS_IN_MONTH[month - 1] ?? 0);
}

/** Weight bands for one zone (or for any zone): they start at 0, follow each other with no gap or overlap, and only the last is open. */
function checkWeightBands(rows: readonly RateRow[], where: string, issues: Issue[]): void {
  const sorted = [...rows].sort((a, b) => a.fromKg - b.fromKg);
  if (sorted[0] !== undefined && sorted[0].fromKg !== 0) issues.push({ path: where, message: `${where}: the first weight band must start at 0 kg.` });
  sorted.forEach((row, i) => {
    const next = sorted[i + 1];
    if (row.toKg === null) {
      if (next !== undefined) issues.push({ path: where, message: `${where}: only the last weight band can be open-ended.` });
    } else if (row.toKg <= row.fromKg) issues.push({ path: where, message: `${where}: a band from ${String(row.fromKg)} kg must end above ${String(row.fromKg)} kg.` });
    else if (next === undefined) issues.push({ path: where, message: `${where}: the last weight band must have no upper limit, so every weight has a fee.` });
    else if (next.fromKg < row.toKg) issues.push({ path: where, message: `${where}: the bands ${String(row.fromKg)}–${String(row.toKg)} kg and ${String(next.fromKg)}–${next.toKg === null ? 'up' : String(next.toKg)} kg overlap.` });
    else if (next.fromKg > row.toKg) issues.push({ path: where, message: `${where}: no fee covers ${String(row.toKg)} to ${String(next.fromKg)} kg.` });
  });
}

function checkDistanceBands(bands: readonly DistanceBand[], issues: Issue[]): void {
  const sorted = [...bands].sort((a, b) => a.fromKm - b.fromKm);
  if (sorted[0] !== undefined && sorted[0].fromKm !== 0) issues.push({ path: 'bands', message: 'The first distance band must start at 0 km.' });
  sorted.forEach((band, i) => {
    const next = sorted[i + 1];
    if (!isMoney(band.baseFee) || !isMoney(band.perKm)) issues.push({ path: 'bands', message: 'A distance band needs a base fee and a rate per kilometre of zero or more.' });
    if (band.toKm === null) {
      if (next !== undefined) issues.push({ path: 'bands', message: 'Only the last distance band can be open-ended.' });
    } else if (band.toKm <= band.fromKm) issues.push({ path: 'bands', message: `A band from ${String(band.fromKm)} km must end above ${String(band.fromKm)} km.` });
    else if (next === undefined) issues.push({ path: 'bands', message: 'The last distance band must have no upper limit, or set a maximum range instead.' });
    else if (next.fromKm < band.toKm) issues.push({ path: 'bands', message: `The distance bands ${String(band.fromKm)}–${String(band.toKm)} km and ${String(next.fromKm)}+ km overlap.` });
    else if (next.fromKm > band.toKm) issues.push({ path: 'bands', message: `No band covers ${String(band.toKm)} to ${String(next.fromKm)} km.` });
  });
}

/**
 * Everything that must be true of a policy before it can go live, in words. The same checks run when a draft is saved, so a policy
 * in force can always be priced. An empty list means it is sound.
 */
export function validatePolicy(p: ChargePolicyDef): Issue[] {
  const issues: Issue[] = [];
  const bad = (path: string, message: string): void => {
    issues.push({ path, message });
  };
  if (p.code.trim() === '') bad('code', 'Give the policy a code.');
  if (p.name.trim() === '') bad('name', 'Give the policy a name.');
  if (!/^[A-Z]{3}$/.test(p.currency)) bad('currency', 'The currency is a three-letter code such as KES.');
  if (!(CHARGE_METHODS as readonly string[]).includes(p.method)) bad('method', 'Choose how the charge is worked out.');
  if (!(DISTANCE_BASES as readonly string[]).includes(p.distanceBasis)) bad('distanceBasis', 'Choose how the distance is measured.');
  if (!(ROUND_MODES as readonly string[]).includes(p.roundMode)) bad('roundMode', 'Choose how the charge is rounded.');
  if (!isMoney(p.roundTo)) bad('roundTo', 'The rounding unit is zero (no rounding) or more.');
  for (const [path, value] of [['minCharge', p.minCharge], ['maxCharge', p.maxCharge]] as const) if (value !== null && !isMoney(value)) bad(path, 'A minimum or maximum charge is zero or more.');
  if (p.minCharge !== null && p.maxCharge !== null && p.minCharge > p.maxCharge) bad('maxCharge', 'The minimum charge is above the maximum charge.');
  if (isMoney(p.roundTo) && p.roundTo > 0) {
    for (const [path, value] of [['minCharge', p.minCharge], ['maxCharge', p.maxCharge]] as const) if (value !== null && isMoney(value) && !multipleOf(value, p.roundTo)) bad(path, `The ${path === 'minCharge' ? 'minimum' : 'maximum'} charge must be a multiple of the rounding unit (${String(p.roundTo)}), so rounding can never break it.`);
  }
  if (p.maxWeightKg !== null && !(isNum(p.maxWeightKg) && p.maxWeightKg > 0)) bad('maxWeightKg', 'The heaviest order is more than 0 kg.');

  if (p.method === 'distance') {
    if (p.rates.length > 0) bad('rates', 'A charge by distance does not use a rate card.');
    if (p.bands.length === 0) bad('bands', 'Add at least one distance band.');
    if (p.bands.length > LIMITS.bands) bad('bands', `Use at most ${String(LIMITS.bands)} distance bands.`);
    checkDistanceBands(p.bands, issues);
    if (!isMoney(p.perMinute)) bad('perMinute', 'The rate per minute is zero or more.');
    if (p.maxRangeKm !== null && !(isNum(p.maxRangeKm) && p.maxRangeKm > 0)) bad('maxRangeKm', 'The furthest distance is more than 0 km.');
    if (p.includedKg !== null && !(isNum(p.includedKg) && p.includedKg >= 0)) bad('includedKg', 'The free weight is zero or more.');
    if (!isMoney(p.perExtraKg)) bad('perExtraKg', 'The fee for each extra kilogram is zero or more.');
    if (p.perExtraKg > 0 && p.includedKg === null) bad('includedKg', 'Say how much weight is free before the fee for extra kilograms starts.');
  } else {
    if (p.bands.length > 0) bad('bands', 'Distance bands belong to a charge by distance.');
    if (p.perMinute !== 0 || p.includedKg !== null || p.perExtraKg !== 0 || p.maxRangeKm !== null) bad('method', 'A rate per minute, free weight or furthest distance belong to a charge by distance.');
    if (p.rates.length === 0) bad('rates', 'Add at least one fee.');
    if (p.rates.length > LIMITS.rates) bad('rates', `Use at most ${String(LIMITS.rates)} fees.`);
    const groups = new Map<string, RateRow[]>();
    for (const row of p.rates) {
      if (!isMoney(row.fee) || !isMoney(row.perExtraKg) || !isNum(row.fromKg) || row.fromKg < 0 || (row.toKg !== null && !isNum(row.toKg))) bad('rates', 'Every fee is a number of zero or more, with weights from 0 kg.');
      if (row.toKg !== null && row.perExtraKg > 0) bad('rates', 'A fee for each extra kilogram belongs to the open top band only.');
      if (p.method === 'flat' && row.zoneId !== null) bad('rates', 'A flat or by-weight charge is the same in every zone, so its fees are not tied to a zone.');
      const key = row.zoneId ?? '*';
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const [key, rows] of groups) checkWeightBands(rows, key === '*' ? 'Fees for any zone' : 'Fees for a zone', issues);
  }

  if (p.tiers.length > LIMITS.tiers) bad('tiers', `Use at most ${String(LIMITS.tiers)} order-value steps.`);
  const tiers = [...p.tiers].sort((a, b) => a.minOrderValue - b.minOrderValue);
  tiers.forEach((t, i) => {
    if (!isMoney(t.minOrderValue)) bad('tiers', 'An order value is zero or more.');
    if (!(isNum(t.percentOff) && t.percentOff > 0 && t.percentOff <= 100)) bad('tiers', 'The percentage off is above 0 and at most 100 (100 is free delivery).');
    const previous = tiers[i - 1];
    if (t.minOrderValue === previous?.minOrderValue) bad('tiers', `Two steps start at the same order value (${String(t.minOrderValue)}).`);
    else if (t.percentOff < (previous?.percentOff ?? 0)) bad('tiers', 'A bigger order should not get a smaller discount than a smaller one.');
  });

  if (p.surcharges.length > LIMITS.surcharges) bad('surcharges', `Use at most ${String(LIMITS.surcharges)} extra charges.`);
  p.surcharges.forEach((s, i) => {
    const at = `Extra charge ${String(i + 1)}`;
    if (s.label.trim() === '' || s.label.length > 60) bad('surcharges', `${at}: give it a name of up to 60 characters.`);
    const kind: string = s.kind;
    if (kind !== 'fixed' && kind !== 'percent') bad('surcharges', `${at}: choose a fixed amount or a percentage.`);
    else if (!isMoney(s.amount) || (kind === 'percent' && s.amount > 500)) bad('surcharges', `${at}: the amount is zero or more${kind === 'percent' ? ' and at most 500%' : ''}.`);
    if (s.days !== null && (s.days.length === 0 || new Set(s.days).size !== s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) bad('surcharges', `${at}: choose days from Sunday to Saturday, each once, or leave days empty for every day.`);
    if ((s.fromMinute === null) !== (s.toMinute === null)) bad('surcharges', `${at}: give both the start and the end of the hours, or neither.`);
    else if (s.fromMinute !== null && s.toMinute !== null && (!Number.isInteger(s.fromMinute) || !Number.isInteger(s.toMinute) || s.fromMinute < 0 || s.fromMinute > 1439 || s.toMinute < 1 || s.toMinute > 1440 || s.fromMinute === s.toMinute)) bad('surcharges', `${at}: the hours must be different times of the day.`);
    if ((s.dateFrom === null) !== (s.dateTo === null)) bad('surcharges', `${at}: give both the first and last date of the season, or neither.`);
    else if (s.dateFrom !== null && (!isMonthDay(s.dateFrom) || !isMonthDay(s.dateTo))) bad('surcharges', `${at}: the season dates are month and day, such as 12-01.`);
  });
  return issues;
}
