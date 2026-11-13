import { describe, expect, it } from 'vitest';
import { checkVehicle, kilos, litres, loadProblem, loadWords } from './delivery-vehicle';

describe('checkVehicle', () => {
  it('takes a name alone, tidies spaces and keeps no limit', () => {
    expect(checkVehicle({ name: '  KDA   123X  Isuzu ' })).toEqual({ ok: true, name: 'KDA 123X Isuzu', maxWeightKg: null, maxVolumeLitres: null, maxStops: null });
  });
  it('takes limits typed as text or numbers and rounds the weight to grams', () => {
    expect(checkVehicle({ name: 'Van', maxWeightKg: '120.4567', maxStops: '6' })).toEqual({ ok: true, name: 'Van', maxWeightKg: 120.457, maxVolumeLitres: null, maxStops: 6 });
    expect(checkVehicle({ name: 'Bike', maxWeightKg: 25, maxStops: 8 })).toMatchObject({ ok: true, maxWeightKg: 25, maxStops: 8 });
  });
  it('treats an empty limit as none', () => {
    expect(checkVehicle({ name: 'Van', maxWeightKg: '', maxStops: null })).toMatchObject({ ok: true, maxWeightKg: null, maxStops: null });
  });
  it('takes a volume in litres, to the thousandth, and refuses one that makes no sense', () => {
    expect(checkVehicle({ name: 'Van', maxVolumeLitres: '1500.5' })).toMatchObject({ ok: true, maxVolumeLitres: 1500.5 });
    expect(checkVehicle({ name: 'Van', maxVolumeLitres: '' })).toMatchObject({ ok: true, maxVolumeLitres: null });
    for (const maxVolumeLitres of [0, -5, 'big', 1_000_001, Number.NaN]) expect(checkVehicle({ name: 'Van', maxVolumeLitres })).toMatchObject({ ok: false });
  });
  it('refuses no name, a long name, and limits that make no sense', () => {
    expect(checkVehicle({ name: '   ' })).toMatchObject({ ok: false });
    expect(checkVehicle({ name: 'x'.repeat(81) })).toMatchObject({ ok: false });
    for (const maxWeightKg of [0, -5, 'heavy', 1_000_001, Number.NaN]) expect(checkVehicle({ name: 'Van', maxWeightKg })).toMatchObject({ ok: false });
    for (const maxStops of [0, 1.5, 501, 'many', -1]) expect(checkVehicle({ name: 'Van', maxStops })).toMatchObject({ ok: false });
  });
});

describe('loadProblem', () => {
  const van = { maxWeightKg: 100, maxVolumeLitres: null, maxStops: 3 };
  it('accepts a load at the limits and any load with no limit', () => {
    expect(loadProblem({ stops: 3, weightKg: 100, volumeLitres: null }, van, 'Van')).toBeNull();
    expect(loadProblem({ stops: 50, weightKg: 9_000, volumeLitres: null }, { maxWeightKg: null, maxVolumeLitres: null, maxStops: null }, 'Van')).toBeNull();
  });
  it('counts goods with no weight as nothing', () => {
    expect(loadProblem({ stops: 2, weightKg: null, volumeLitres: null }, van, 'Van')).toBeNull();
  });
  it('says what is over, with the numbers', () => {
    expect(loadProblem({ stops: 4, weightKg: 10, volumeLitres: null }, van, 'Van')).toBe('Van takes at most 3 stops on a run; this would be 4.');
    expect(loadProblem({ stops: 1, weightKg: 100.5, volumeLitres: null }, van, 'Van')).toBe('Van carries at most 100 kg; this run would carry 100.5 kg.');
    expect(loadProblem({ stops: 2, weightKg: 1, volumeLitres: null }, { maxWeightKg: null, maxVolumeLitres: null, maxStops: 1 }, 'Bike')).toBe('Bike takes at most 1 stop on a run; this would be 2.');
  });
});

describe('loadWords', () => {
  it('shows the load against each limit', () => {
    expect(loadWords({ stops: 4, weightKg: 85, volumeLitres: null }, { maxWeightKg: 120, maxVolumeLitres: null, maxStops: 6 })).toBe('85 kg of 120 kg · 4 of 6 stops');
    expect(loadWords({ stops: 1, weightKg: null, volumeLitres: null }, { maxWeightKg: 120, maxVolumeLitres: null, maxStops: null })).toBe('no weights known, up to 120 kg · 1 stop');
    expect(loadWords({ stops: 2, weightKg: 12.5, volumeLitres: null }, null)).toBe('12.5 kg · 2 stops');
    expect(loadWords({ stops: 0, weightKg: null, volumeLitres: null }, null)).toBe('0 stops');
    expect(kilos(0.25)).toBe('0.25 kg');
  });
});

describe('volume', () => {
  const van = { maxWeightKg: null, maxVolumeLitres: 500, maxStops: null };
  it('accepts a load up to the limit and counts goods with no size as nothing', () => {
    expect(loadProblem({ stops: 2, weightKg: null, volumeLitres: 500 }, van, 'Van')).toBeNull();
    expect(loadProblem({ stops: 2, weightKg: null, volumeLitres: null }, van, 'Van')).toBeNull();
    expect(loadProblem({ stops: 2, weightKg: null, volumeLitres: 9_999 }, { ...van, maxVolumeLitres: null }, 'Van')).toBeNull();
  });
  it('says what is over, with the numbers, after the weight and the stops', () => {
    expect(loadProblem({ stops: 1, weightKg: null, volumeLitres: 500.5 }, van, 'Van')).toBe('Van holds at most 500 litres; this run would fill 500.5 litres.');
    expect(loadProblem({ stops: 1, weightKg: 200, volumeLitres: 900 }, { maxWeightKg: 100, maxVolumeLitres: 500, maxStops: null }, 'Van')).toContain('carries at most 100 kg');
  });
  it('shows the space against its limit', () => {
    expect(loadWords({ stops: 3, weightKg: 85, volumeLitres: 320 }, { maxWeightKg: 120, maxVolumeLitres: 500, maxStops: 6 })).toBe('85 kg of 120 kg · 320 litres of 500 litres · 3 of 6 stops');
    expect(loadWords({ stops: 1, weightKg: null, volumeLitres: null }, van)).toBe('no volumes known, up to 500 litres · 1 stop');
    expect(loadWords({ stops: 2, weightKg: null, volumeLitres: 1200 }, null)).toBe('1,200 litres · 2 stops');
    expect(litres(1)).toBe('1 litre');
  });
});
