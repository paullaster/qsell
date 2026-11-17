import { describe, expect, it } from 'vitest';
import { minutesOfTime, rulesWords, timeOfMinutes } from './package-choices';

const none = { minServings: null, maxServings: null, noticeMinutes: null, closesDaysBefore: null, closesAtMinute: null, weekdays: [], dailyLimit: null, audience: 'anyone' };

describe('times of day for the rules', () => {
  it('reads HH:MM and refuses anything else', () => {
    expect(minutesOfTime('10:30')).toBe(630);
    expect(minutesOfTime('0:05')).toBe(5);
    for (const bad of ['', '24:00', '10:60', '1030', 'ab:cd']) expect(minutesOfTime(bad)).toBeNull();
    expect(timeOfMinutes(630)).toBe('10:30');
  });
});

describe('the rules in words', () => {
  it('says nothing when there are no rules', () => expect(rulesWords(none)).toEqual([]));
  it('names each rule that is set', () => {
    expect(rulesWords({ ...none, minServings: 5, maxServings: 20, noticeMinutes: 1440, closesDaysBefore: 1, closesAtMinute: 600, weekdays: [1, 3], dailyLimit: 40, audience: 'signed_in' })).toEqual([
      '5 to 20 servings', '24 h notice', 'Closes 1 day before at 10:00', 'Mon, Wed', '40 servings a day', 'Signed-in only',
    ]);
    expect(rulesWords({ ...none, minServings: 10 })).toEqual(['From 10 servings']);
    expect(rulesWords({ ...none, maxServings: 8, closesDaysBefore: 0, closesAtMinute: 480, audience: 'groups' })).toEqual(['Up to 8 servings', 'Closes on the day at 08:00', 'Chosen groups only']);
  });
});
