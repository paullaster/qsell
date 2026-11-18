import { describe, expect, it } from 'vitest';
import { fromBusinessInput, itemsFromLines, toBusinessInput, checkCrew, checkItems, checkWindow, checklistProblem, isVisitOver, nextVisitStatus, reasonProblem, signOffProblem, visitActionsFrom, checkTimeRequest } from './visit';

const now = new Date('2026-11-06T09:00:00Z');

describe('the visit\'s states', () => {
  it('walk from booked to signed off, and cannot go back', () => {
    let s = nextVisitStatus('scheduled', 'assign');
    expect(s).toBe('crew_assigned');
    s = nextVisitStatus('crew_assigned', 'start');
    expect(s).toBe('on_site');
    s = nextVisitStatus('on_site', 'complete');
    expect(s).toBe('completed');
    expect(nextVisitStatus('completed', 'sign_off')).toBe('signed_off');
    expect(nextVisitStatus('scheduled', 'start')).toBeNull();
    expect(nextVisitStatus('on_site', 'assign')).toBeNull();
    expect(nextVisitStatus('completed', 'cancel')).toBeNull();
  });

  it('can have its crew changed and its time moved until the crew is on site, and cancelled until the work is done', () => {
    expect(nextVisitStatus('crew_assigned', 'assign')).toBe('crew_assigned');
    expect(nextVisitStatus('crew_assigned', 'reschedule')).toBe('crew_assigned');
    expect(nextVisitStatus('scheduled', 'reschedule')).toBe('scheduled');
    expect(nextVisitStatus('on_site', 'reschedule')).toBeNull();
    for (const s of ['scheduled', 'crew_assigned', 'on_site'] as const) expect(nextVisitStatus(s, 'cancel')).toBe('cancelled');
  });

  it('are over when signed off or cancelled', () => {
    expect(isVisitOver('signed_off')).toBe(true);
    expect(isVisitOver('cancelled')).toBe(true);
    expect(isVisitOver('on_site')).toBe(false);
    expect(visitActionsFrom('signed_off')).toEqual([]);
  });
});

describe('the time of a visit', () => {
  it('starts in the future, ends after it starts, and is within a working day', () => {
    expect(checkWindow('2026-11-07T08:00:00Z', '2026-11-07T11:00:00Z', now)).toMatchObject({ ok: true });
    expect(checkWindow('2026-11-06T08:00:00Z', '2026-11-06T11:00:00Z', now)).toMatchObject({ ok: false, error: expect.stringMatching(/future/) as string });
    expect(checkWindow('2026-11-07T11:00:00Z', '2026-11-07T08:00:00Z', now)).toMatchObject({ ok: false, error: expect.stringMatching(/after it starts/) as string });
    expect(checkWindow('2026-11-07T08:00:00Z', '2026-11-07T21:00:00Z', now)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 12 hours/) as string });
    for (const bad of [[null, null], ['soon', 'later'], [undefined, '2026-11-07T11:00:00Z']]) expect(checkWindow(bad[0], bad[1], now)).toMatchObject({ ok: false });
  });
});

describe('who goes, what is ticked and who signs', () => {
  it('a crew is one to eight people, each once', () => {
    expect(checkCrew(['a', 'b'])).toEqual({ ok: true, ids: ['a', 'b'] });
    for (const bad of [[], 'a', ['a', 'a'], ['a', ''], Array.from({ length: 9 }, (_, i) => `r${String(i)}`)]) expect(checkCrew(bad)).toMatchObject({ ok: false });
  });

  it('a checklist is words, each short, none twice', () => {
    expect(checkItems([' Fit the unit ', 'Test it'])).toEqual({ ok: true, items: ['Fit the unit', 'Test it'] });
    for (const bad of [[], 'x', [''], ['a', 'A'], ['x'.repeat(121)], Array.from({ length: 31 }, (_, i) => `item ${String(i)}`)]) expect(checkItems(bad)).toMatchObject({ ok: false });
  });

  it('the work is done when every item is ticked', () => {
    expect(checklistProblem([{ done: true }, { done: true }])).toBeNull();
    expect(checklistProblem([])).toBeNull();
    expect(checklistProblem([{ done: true }, { done: false }])).toBe('1 item is not ticked on the checklist yet.');
    expect(checklistProblem([{ done: false }, { done: false }])).toBe('2 items are not ticked on the checklist yet.');
  });

  it('a sign-off names who signed, and a reason is a few words', () => {
    expect(signOffProblem('Mama Wanjiku')).toBeNull();
    for (const bad of ['', ' ', 'A', null, 5]) expect(signOffProblem(bad)).not.toBeNull();
    expect(reasonProblem('Customer was away', 'the visit is cancelled')).toBeNull();
    expect(reasonProblem('no', 'the visit is cancelled')).toMatch(/Say why the visit is cancelled/);
  });
});

describe('times typed in Nairobi', () => {
  it('go to the instant they mean and come back the same', () => {
    expect(fromBusinessInput('2026-11-07T08:00', 'Africa/Nairobi')).toBe('2026-11-07T05:00:00.000Z');
    expect(toBusinessInput('2026-11-07T05:00:00.000Z', 'Africa/Nairobi')).toBe('2026-11-07T08:00');
    expect(toBusinessInput(fromBusinessInput('2026-12-31T23:30', 'Africa/Nairobi') ?? '', 'Africa/Nairobi')).toBe('2026-12-31T23:30');
    // On the clock of whatever zone the business chose, daylight saving included.
    expect(fromBusinessInput('2026-11-07T08:00', 'Asia/Tokyo')).toBe('2026-11-06T23:00:00.000Z');
    expect(fromBusinessInput('2026-11-07T08:00', 'Europe/London')).toBe('2026-11-07T08:00:00.000Z');
    expect(fromBusinessInput('2026-07-07T08:00', 'Europe/London')).toBe('2026-07-07T07:00:00.000Z');
    expect(fromBusinessInput('2026-11-07T08:00', 'America/New_York')).toBe('2026-11-07T13:00:00.000Z');
    expect(toBusinessInput('2026-11-06T23:00:00.000Z', 'Asia/Tokyo')).toBe('2026-11-07T08:00');
    for (const zone of ['Africa/Nairobi', 'Asia/Kolkata', 'Pacific/Auckland', 'America/Los_Angeles']) expect(toBusinessInput(fromBusinessInput('2026-03-29T01:30', zone) ?? '', zone), zone).toBe('2026-03-29T01:30');
    for (const bad of ['', 'tomorrow', '2026-11-07', '2026-13-45T99:99']) expect(fromBusinessInput(bad, 'Africa/Nairobi')).toBeNull();
  });

  it('a checklist is typed a line to an item', () => {
    expect(itemsFromLines(' Fit it \n\n Test it\n  ')).toEqual(['Fit it', 'Test it']);
    expect(itemsFromLines('')).toEqual([]);
  });
});

describe('the words a customer writes when they ask for another time', () => {
  it('are cleaned up and kept: a few words to a short paragraph', () => {
    expect(checkTimeRequest('  Thursday   morning,\n please ')).toEqual({ ok: true, note: 'Thursday morning, please' });
    expect(checkTimeRequest('x'.repeat(300))).toMatchObject({ ok: true });
  });
  it('are refused in words when empty, too short, too long, or a link', () => {
    for (const bad of [undefined, null, 7, '', '  ', 'ab']) expect(checkTimeRequest(bad)).toMatchObject({ ok: false, error: expect.stringContaining('few words') as string });
    expect(checkTimeRequest('x'.repeat(301))).toMatchObject({ ok: false, error: expect.stringContaining('300') as string });
    expect(checkTimeRequest('see https://example.test')).toMatchObject({ ok: false, error: expect.stringContaining('link') as string });
    expect(checkTimeRequest('go to www.example.test')).toMatchObject({ ok: false });
  });
});
