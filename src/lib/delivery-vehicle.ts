/**
 * Vehicles of the delivery fleet and what a run may carry in each. These are the rules only: the register (a name, and optionally the most
 * weight, the most volume and the most stops) and whether a run's load fits. Goods with no weight or no volume count as nothing, as they
 * do for delivery slots.
 */

export const MAX_VEHICLE_KG = 1_000_000;
export const MAX_VEHICLE_LITRES = 1_000_000;
export const MAX_VEHICLE_STOPS = 500;
export const VEHICLE_NAME_MAX = 80;

export interface VehicleLimits {
  maxWeightKg: number | null;
  /** The most the run may fill, in litres (1,000 litres is a cubic metre). */
  maxVolumeLitres: number | null;
  maxStops: number | null;
}

export type VehicleChecked = ({ ok: true; name: string } & VehicleLimits) | { ok: false; error: string };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** A number typed or sent for a limit; empty means no limit. */
function limitOf(raw: unknown): number | null | 'bad' {
  if (raw === null || raw === undefined || raw === '') return null;
  let n = Number.NaN;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
  return Number.isFinite(n) ? n : 'bad';
}

/** A vehicle as typed: a name, and the limits it may have (either, both or neither). */
export function checkVehicle(input: { name?: unknown; maxWeightKg?: unknown; maxVolumeLitres?: unknown; maxStops?: unknown }): VehicleChecked {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (name === '') return { ok: false, error: 'Give the vehicle a name or number plate.' };
  if (name.length > VEHICLE_NAME_MAX) return { ok: false, error: `The name is at most ${String(VEHICLE_NAME_MAX)} characters.` };
  const weight = limitOf(input.maxWeightKg);
  if (weight === 'bad' || (weight !== null && (weight <= 0 || weight > MAX_VEHICLE_KG))) return { ok: false, error: 'The weight limit is more than nothing and at most 1,000,000 kg, or leave it empty.' };
  const volume = limitOf(input.maxVolumeLitres);
  if (volume === 'bad' || (volume !== null && (volume <= 0 || volume > MAX_VEHICLE_LITRES))) return { ok: false, error: 'The volume limit is more than nothing and at most 1,000,000 litres, or leave it empty.' };
  const stops = limitOf(input.maxStops);
  if (stops === 'bad' || (stops !== null && (!Number.isInteger(stops) || stops < 1 || stops > MAX_VEHICLE_STOPS))) return { ok: false, error: `The most stops is a whole number from 1 to ${String(MAX_VEHICLE_STOPS)}, or leave it empty.` };
  return { ok: true, name, maxWeightKg: weight === null ? null : round3(weight), maxVolumeLitres: volume === null ? null : round3(volume), maxStops: stops };
}

/** Why a load does not fit a vehicle, in words, or null when it does. `weightKg` and `volumeLitres` are null when nothing on the run has one. */
export function loadProblem(load: { stops: number; weightKg: number | null; volumeLitres: number | null }, limits: VehicleLimits, vehicleName: string): string | null {
  if (limits.maxStops !== null && load.stops > limits.maxStops) {
    return `${vehicleName} takes at most ${String(limits.maxStops)} ${limits.maxStops === 1 ? 'stop' : 'stops'} on a run; this would be ${String(load.stops)}.`;
  }
  if (limits.maxWeightKg !== null && load.weightKg !== null && round3(load.weightKg) > limits.maxWeightKg) {
    return `${vehicleName} carries at most ${kilos(limits.maxWeightKg)}; this run would carry ${kilos(load.weightKg)}.`;
  }
  if (limits.maxVolumeLitres !== null && load.volumeLitres !== null && round3(load.volumeLitres) > limits.maxVolumeLitres) {
    return `${vehicleName} holds at most ${litres(limits.maxVolumeLitres)}; this run would fill ${litres(load.volumeLitres)}.`;
  }
  return null;
}

/** "85 kg" or "12.5 kg". */
export function kilos(kg: number): string {
  return `${String(round3(kg))} kg`;
}

/** "1,200 litres" or "1 litre". */
export function litres(l: number): string {
  const n = round3(l);
  return `${n.toLocaleString('en-KE')} ${n === 1 ? 'litre' : 'litres'}`;
}

/** The load against the limits, for the run screen: "85 kg of 120 kg · 300 litres of 500 litres · 4 of 6 stops", or what there is when a part has no limit. */
export function loadWords(load: { stops: number; weightKg: number | null; volumeLitres: number | null }, limits: VehicleLimits | null): string {
  const stops = `${String(load.stops)} ${load.stops === 1 ? 'stop' : 'stops'}`;
  const weight = load.weightKg === null ? null : kilos(load.weightKg);
  const volume = load.volumeLitres === null ? null : litres(load.volumeLitres);
  if (limits === null) return [weight, volume, stops].filter((p): p is string => p !== null).join(' · ');
  let w = weight;
  if (limits.maxWeightKg !== null) w = weight === null ? `no weights known, up to ${kilos(limits.maxWeightKg)}` : `${weight} of ${kilos(limits.maxWeightKg)}`;
  let v = volume;
  if (limits.maxVolumeLitres !== null) v = volume === null ? `no volumes known, up to ${litres(limits.maxVolumeLitres)}` : `${volume} of ${litres(limits.maxVolumeLitres)}`;
  const s = limits.maxStops === null ? stops : `${String(load.stops)} of ${String(limits.maxStops)} stops`;
  return [w, v, s].filter((p): p is string => p !== null).join(' · ');
}
