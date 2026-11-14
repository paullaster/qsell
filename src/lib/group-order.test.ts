import { describe, expect, it } from 'vitest';
import { cleanDay, cleanPersonName, cleanTitle, groupAcceptsChoices, groupCartLines, groupClosedReason, isWellFormedGroupToken, MAX_PERSON_NAME } from './group-order';

describe('the link of a group order', () => {
  it('is 32 characters of the base64url alphabet and nothing else', () => {
    expect(isWellFormedGroupToken('A'.repeat(32))).toBe(true);
    expect(isWellFormedGroupToken('abc_-DEF'.repeat(4))).toBe(true);
    for (const bad of ['', 'x'.repeat(31), 'x'.repeat(33), `${'x'.repeat(31)}!`, `${'x'.repeat(31)} `, 5, null]) expect(isWellFormedGroupToken(bad)).toBe(false);
  });
});

describe('what people type', () => {
  it('cleans a name to plain, bounded text', () => {
    expect(cleanPersonName('  Wanjiru   Kamau ')).toBe('Wanjiru Kamau');
    expect(cleanPersonName('x'.repeat(200))).toHaveLength(MAX_PERSON_NAME);
    expect(cleanPersonName('   ')).toBe('');
    expect(cleanPersonName(42)).toBe('');
    // Markup is kept as the text it is; the screens only ever show it as text.
    expect(cleanPersonName('<b>Joe</b>')).toBe('<b>Joe</b>');
  });
  it('cleans a title and reads a day', () => {
    expect(cleanTitle('  Friday   team lunch ')).toBe('Friday team lunch');
    expect(cleanDay('2026-12-25')).toBe('2026-12-25');
    for (const bad of ['2026-02-30', '25/12/2026', '', null, 7]) expect(cleanDay(bad)).toBeNull();
  });
});

describe('whether choices are still taken', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  it('is while the group is open and its time has not come', () => {
    expect(groupAcceptsChoices({ status: 'open', closesAt: null }, now)).toBe(true);
    expect(groupAcceptsChoices({ status: 'open', closesAt: new Date('2026-11-14T10:00:01Z') }, now)).toBe(true);
    expect(groupClosedReason({ status: 'open', closesAt: null }, now)).toBeNull();
  });
  it('stops at the closing time, when the organiser closes it and when it is cancelled, each saying why', () => {
    expect(groupAcceptsChoices({ status: 'open', closesAt: now }, now)).toBe(false);
    expect(groupClosedReason({ status: 'open', closesAt: new Date('2026-11-14T09:00:00Z') }, now)).toContain('time to choose is over');
    expect(groupClosedReason({ status: 'closed', closesAt: null }, now)).toContain('organiser has stopped');
    expect(groupClosedReason({ status: 'cancelled', closesAt: null }, now)).toContain('cancelled');
    expect(groupAcceptsChoices({ status: 'closed', closesAt: null }, now)).toBe(false);
  });
});

describe('the organiser cart', () => {
  it('joins identical choices into one line with that many servings, and keeps who is behind each', () => {
    const lines = groupCartLines([
      { selectionKey: 'a', personName: 'Amina', picks: ['fish'], note: '' },
      { selectionKey: 'b', personName: 'Brian', picks: ['beef'], note: 'no pepper' },
      { selectionKey: 'a', personName: 'Chao', picks: ['fish'], note: '' },
    ]);
    expect(lines).toEqual([
      { selectionKey: 'a', picks: ['fish'], note: '', servings: 2, people: ['Amina', 'Chao'] },
      { selectionKey: 'b', picks: ['beef'], note: 'no pepper', servings: 1, people: ['Brian'] },
    ]);
    expect(groupCartLines([])).toEqual([]);
  });
});
