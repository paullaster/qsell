import { describe, expect, it } from 'vitest';
import { DELIVERY_METHODS, METHOD_WORDS, isDeliveryMethod, leadTimeWords, readMethodSettings } from './delivery-methods';

describe('delivery methods', () => {
  it('know the four methods, each in words', () => {
    expect(DELIVERY_METHODS).toEqual(['own_fleet', 'courier', 'pickup', 'scheduled_visit']);
    for (const m of DELIVERY_METHODS) expect(METHOD_WORDS[m].name).not.toBe('');
    expect(isDeliveryMethod('pickup')).toBe(true);
    expect(isDeliveryMethod('drone')).toBe(false);
    expect(isDeliveryMethod(null)).toBe(false);
  });
  it('read the settings of one method, and refuse what cannot be', () => {
    expect(readMethodSettings({ isActive: true, leadTimeMinutes: '90', note: '  Call first  ' })).toEqual({ ok: true, value: { isActive: true, leadTimeMinutes: 90, note: 'Call first' } });
    expect(readMethodSettings({ isActive: false, leadTimeMinutes: 0, note: '' })).toEqual({ ok: true, value: { isActive: false, leadTimeMinutes: 0, note: null } });
    for (const bad of [{ isActive: 'yes', leadTimeMinutes: 0 }, { isActive: true, leadTimeMinutes: -1 }, { isActive: true, leadTimeMinutes: 1.5 }, { isActive: true, leadTimeMinutes: 43201 }, { isActive: true, leadTimeMinutes: 'soon' }, { isActive: true, leadTimeMinutes: '' }]) {
      expect(readMethodSettings(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    const long = readMethodSettings({ isActive: true, leadTimeMinutes: 5, note: 'x'.repeat(300) });
    expect(long.ok && long.value.note?.length).toBe(200);
  });
  it('say a preparation time in everyday words', () => {
    expect(leadTimeWords(0)).toBe('Ready at once');
    expect(leadTimeWords(1)).toBe('1 minute');
    expect(leadTimeWords(30)).toBe('30 minutes');
    expect(leadTimeWords(60)).toBe('1 hour');
    expect(leadTimeWords(120)).toBe('2 hours');
    expect(leadTimeWords(1440)).toBe('1 day');
    expect(leadTimeWords(2880)).toBe('2 days');
    expect(leadTimeWords(90)).toBe('1 h 30 min');
  });
});
