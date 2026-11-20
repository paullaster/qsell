import { describe, expect, it } from 'vitest';
import { BUILT_IN_TIME_ZONE, dayInZone, instantInZone, isValidTimeZone, offsetLabel, readTimeZone, runtimeZones, zoneOffsetMs, zonesFromList } from './business-timezone';

describe('the business time zone', () => {
  it('starts as Africa/Nairobi and that is a zone the system can use', () => {
    expect(BUILT_IN_TIME_ZONE).toBe('Africa/Nairobi');
    expect(isValidTimeZone(BUILT_IN_TIME_ZONE)).toBe(true);
  });

  it('accepts places and UTC, and refuses abbreviations, offsets, made-up names, odd shapes and non-text', () => {
    for (const ok of ['Africa/Nairobi', 'America/Argentina/Buenos_Aires', 'Europe/London', 'Asia/Kolkata', 'UTC']) expect(isValidTimeZone(ok), ok).toBe(true);
    for (const bad of ['EST', 'GMT+3', '+03:00', 'Nairobi', 'Mars/Olympus_Mons', 'Africa/', '/Africa/Nairobi', 'Africa//Nairobi', 'Africa/Nai robi', '', ' ', 'A'.repeat(65), null, undefined, 3, {}]) expect(isValidTimeZone(bad), typeof bad === 'string' ? bad : typeof bad).toBe(false);
  });

  it('reads a zone as chosen, trimmed, and says in words what is wrong with one that is not usable', () => {
    expect(readTimeZone('  Europe/London ')).toEqual({ ok: true, timeZone: 'Europe/London' });
    expect(readTimeZone('')).toEqual({ ok: false, error: 'Choose the business time zone.' });
    expect(readTimeZone(undefined)).toEqual({ ok: false, error: 'Choose the business time zone.' });
    const bad = readTimeZone('Mars/Olympus_Mons');
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.error).toContain('is not a time zone this system knows');
    // Nothing of an overlong or script-carrying value is repeated in full.
    const long = readTimeZone(`<script>${'x'.repeat(200)}</script>`);
    expect(long.ok ? '' : long.error.length).toBeLessThan(220);
  });

  it('keeps only usable zones from an outside list, once each in order, and says nothing usable when there is none', () => {
    expect(zonesFromList(['Europe/London', 'Africa/Nairobi', 'Africa/Nairobi', 'EST', 'Mars/X', 42, null, '<b>'])).toEqual(['Africa/Nairobi', 'Europe/London']);
    expect(zonesFromList([])).toBeNull();
    expect(zonesFromList(['EST', 'nonsense'])).toBeNull();
    expect(zonesFromList({ zones: ['Africa/Nairobi'] })).toBeNull();
    expect(zonesFromList('Africa/Nairobi')).toBeNull();
    expect(zonesFromList(null)).toBeNull();
  });

  it('knows the zones of its own runtime, with UTC, each once, sorted and all usable', () => {
    const own = runtimeZones();
    expect(own.length).toBeGreaterThan(100);
    expect(own).toContain('Africa/Nairobi');
    expect(own).toContain('UTC');
    expect(new Set(own).size).toBe(own.length);
    expect(own.every(isValidTimeZone)).toBe(true);
    expect([...own].sort((a, b) => a.localeCompare(b))).toEqual(own);
  });

  it('writes how far a zone is from UTC at an instant, as it was then', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');
    expect(offsetLabel('Africa/Nairobi', winter)).toBe('UTC+03:00');
    expect(offsetLabel('Europe/London', winter)).toBe('UTC+00:00');
    expect(offsetLabel('Europe/London', summer)).toBe('UTC+01:00');
    expect(offsetLabel('America/New_York', winter)).toBe('UTC-05:00');
    expect(offsetLabel('UTC', winter)).toBe('UTC+00:00');
    expect(offsetLabel('Not/AZone', winter)).toBe('');
  });
});

describe('turning a clock time and a day into an instant, in any zone', () => {
  it('reads the offset of a zone at an instant, daylight saving included', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Africa/Nairobi')).toBe(3 * 3_600_000);
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Europe/London')).toBe(0);
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'Europe/London')).toBe(3_600_000);
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3_600_000);
  });

  it('finds the instant of a wall-clock time on a day', () => {
    expect(instantInZone('2026-11-05', '09:00', 'Africa/Nairobi').toISOString()).toBe('2026-11-05T06:00:00.000Z');
    expect(instantInZone('2026-11-05', '09:00', 'Europe/London').toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(instantInZone('2026-07-05', '09:00', 'Europe/London').toISOString()).toBe('2026-07-05T08:00:00.000Z');
    expect(instantInZone('2026-11-05', '09:00', 'America/New_York').toISOString()).toBe('2026-11-05T14:00:00.000Z');
    expect(instantInZone('2026-11-05', '09:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-05T03:30:00.000Z');
    expect(instantInZone('2026-11-05', '00:00', 'Pacific/Auckland').toISOString()).toBe('2026-11-04T11:00:00.000Z');
  });

  it('is right on the day the clocks change', () => {
    // London springs forward at 01:00 UTC on 29 March 2026: 12:00 that day is already summer time.
    expect(instantInZone('2026-03-29', '12:00', 'Europe/London').toISOString()).toBe('2026-03-29T11:00:00.000Z');
    expect(instantInZone('2026-03-28', '12:00', 'Europe/London').toISOString()).toBe('2026-03-28T12:00:00.000Z');
    // And falls back on 25 October.
    expect(instantInZone('2026-10-25', '12:00', 'Europe/London').toISOString()).toBe('2026-10-25T12:00:00.000Z');
  });

  it('says which calendar day an instant is on in a zone', () => {
    const at = new Date('2026-11-05T21:30:00Z');
    expect(dayInZone(at, 'Africa/Nairobi')).toBe('2026-11-06');
    expect(dayInZone(at, 'Europe/London')).toBe('2026-11-05');
    expect(dayInZone(at, 'Pacific/Auckland')).toBe('2026-11-06');
    expect(dayInZone(at, 'America/Los_Angeles')).toBe('2026-11-05');
  });
});
