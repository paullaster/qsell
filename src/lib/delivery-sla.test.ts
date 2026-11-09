import { describe, expect, it } from 'vitest';
import { audienceFor, checkSlaSettings, readAddressList, lateWords, levelsReached, slaState, windowWords } from './delivery-sla';

const start = new Date('2026-11-06T06:00:00Z'); // 09:00 Nairobi
const end = new Date('2026-11-06T09:00:00Z'); // 12:00 Nairobi
const base = { windowStart: start, windowEnd: end, deliveredAt: null, atRiskMinutes: 60 };
const at = (iso: string) => new Date(iso);

describe('where a delivery stands against its window', () => {
  it('is on track before the window and while it is on its way', () => {
    expect(slaState({ ...base, status: 'ready', now: at('2026-11-06T04:00:00Z') })).toBe('on_track');
    expect(slaState({ ...base, status: 'out_for_delivery', now: at('2026-11-06T07:00:00Z') })).toBe('on_track');
  });

  it('is at risk when the window has begun and it is not on its way, or the end is near', () => {
    expect(slaState({ ...base, status: 'packed', now: at('2026-11-06T06:30:00Z') })).toBe('at_risk');
    expect(slaState({ ...base, status: 'out_for_delivery', now: at('2026-11-06T08:10:00Z') })).toBe('at_risk');
    expect(slaState({ ...base, status: 'ready', now: at('2026-11-06T05:59:00Z') })).toBe('on_track');
  });

  it('is late past the end of the window', () => {
    expect(slaState({ ...base, status: 'out_for_delivery', now: at('2026-11-06T09:00:01Z') })).toBe('late');
    expect(slaState({ ...base, status: 'failed_attempt', now: at('2026-11-07T09:00:00Z') })).toBe('late');
  });

  it('is met or missed once delivered, by the time it arrived', () => {
    expect(slaState({ ...base, status: 'delivered', deliveredAt: at('2026-11-06T08:59:00Z'), now: at('2026-11-07T00:00:00Z') })).toBe('met');
    expect(slaState({ ...base, status: 'delivered', deliveredAt: at('2026-11-06T09:30:00Z'), now: at('2026-11-07T00:00:00Z') })).toBe('missed');
  });

  it('is nothing when no window was promised or it is no longer expected', () => {
    expect(slaState({ ...base, windowStart: null, windowEnd: null, status: 'ready', now: end })).toBeNull();
    expect(slaState({ ...base, status: 'cancelled', now: at('2026-11-07T00:00:00Z') })).toBeNull();
    expect(slaState({ ...base, status: 'returned', now: at('2026-11-07T00:00:00Z') })).toBeNull();
  });
});

describe('how far up it has gone', () => {
  const lateAt = (min: number) => new Date(end.getTime() + min * 60_000);
  it('reaches each level in order, the supervisor after the set time late', () => {
    expect(levelsReached({ state: 'on_track', windowEnd: end, now: start, escalateAfterMinutes: 60 })).toEqual([]);
    expect(levelsReached({ state: 'at_risk', windowEnd: end, now: lateAt(-30), escalateAfterMinutes: 60 })).toEqual(['at_risk']);
    expect(levelsReached({ state: 'late', windowEnd: end, now: lateAt(10), escalateAfterMinutes: 60 })).toEqual(['at_risk', 'late']);
    expect(levelsReached({ state: 'late', windowEnd: end, now: lateAt(60), escalateAfterMinutes: 60 })).toEqual(['at_risk', 'late', 'escalated']);
    expect(levelsReached({ state: 'met', windowEnd: end, now: lateAt(600), escalateAfterMinutes: 60 })).toEqual([]);
    expect(levelsReached({ state: null, windowEnd: null, now: end, escalateAfterMinutes: 60 })).toEqual([]);
  });
});

describe('words and settings', () => {
  it('says how late and the window as the customer is told it', () => {
    expect(lateWords(1)).toBe('1 minute');
    expect(lateWords(12)).toBe('12 minutes');
    expect(lateWords(125)).toBe('2 hours 5 min');
    expect(lateWords(1500)).toBe('1 day 1 hour');
    expect(lateWords(-4)).toBe('0 minutes');
    expect(windowWords(start, end)).toBe('Fri 6 Nov, 09:00 to 12:00');
  });

  it('checks the settings as typed', () => {
    expect(checkSlaSettings({ atRiskMinutes: 45, escalateAfterMinutes: 30 })).toEqual({ ok: true, atRiskMinutes: 45, escalateAfterMinutes: 30 });
    expect(checkSlaSettings({ atRiskMinutes: 0, escalateAfterMinutes: 1 })).toMatchObject({ ok: true });
    for (const bad of [{ atRiskMinutes: -1, escalateAfterMinutes: 30 }, { atRiskMinutes: 2000, escalateAfterMinutes: 30 }, { atRiskMinutes: 30, escalateAfterMinutes: 0 }, { atRiskMinutes: 30, escalateAfterMinutes: 'x' }, { atRiskMinutes: 1.5, escalateAfterMinutes: 30 }, {}]) expect(checkSlaSettings(bad)).toMatchObject({ ok: false });
  });
});

describe('who is mailed about lateness', () => {
  it('reads addresses typed with commas, spaces, semicolons or new lines, in lower case and none twice', () => {
    expect(readAddressList(' Ops@Shop.co.ke, ops@shop.co.ke;\n boss@shop.co.ke ')).toEqual({ ok: true, addresses: ['ops@shop.co.ke', 'boss@shop.co.ke'] });
    expect(readAddressList(['a@b.co'])).toEqual({ ok: true, addresses: ['a@b.co'] });
    for (const empty of [undefined, null, '', '  , ; ']) expect(readAddressList(empty)).toEqual({ ok: true, addresses: [] });
  });

  it('refuses what is not an address, too many, and things that are not text', () => {
    expect(readAddressList('ops@shop.co.ke, nobody')).toMatchObject({ ok: false, error: expect.stringContaining('nobody') as string });
    expect(readAddressList('a@b')).toMatchObject({ ok: false });
    expect(readAddressList(Array.from({ length: 11 }, (_, i) => `u${String(i)}@x.co`).join(','))).toMatchObject({ ok: false });
    expect(readAddressList(Array.from({ length: 10 }, (_, i) => `u${String(i)}@x.co`).join(','))).toMatchObject({ ok: true });
    expect(readAddressList(42)).toMatchObject({ ok: false });
    expect(readAddressList([1, 2])).toMatchObject({ ok: false });
    expect(readAddressList(`${'x'.repeat(250)}@x.co`)).toMatchObject({ ok: false });
  });

  it('mails the dispatchers for the first two levels and the supervisors for the third', () => {
    expect(audienceFor('at_risk')).toBe('dispatch');
    expect(audienceFor('late')).toBe('dispatch');
    expect(audienceFor('escalated')).toBe('supervisor');
  });
});
