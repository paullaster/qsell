import { describe, expect, it } from 'vitest';
import { EN } from '@/lib/reports/messages/en';
import { MESSAGE_IDS, slotsOf, t } from '@/lib/reports/messages';

describe('report messages', () => {
  it('fills the named slots', () => {
    expect(t('common.updated', { time: '15 Oct, 14:05' })).toBe('Updated 15 Oct, 14:05');
    expect(t('common.up_by', { percent: 12.4, basis: 'last month' })).toBe(
      'up 12.4% on last month',
    );
  });

  it('needs no arguments for a message without slots', () => {
    expect(t('common.try_again')).toBe('Try again');
  });

  it('leaves a missing slot visible rather than dropping it', () => {
    // The compiler refuses a missing slot; this guards a caller that gets round it with a cast.
    const loose = t as unknown as (id: string, slots: Record<string, string>) => string;
    expect(loose('common.updated', {})).toBe('Updated {time}');
  });

  it('uses only lower-case snake names for slots and never leaves a stray brace', () => {
    for (const id of MESSAGE_IDS) {
      const text: string = EN[id];
      const stripped = text.replace(/\{[a-z_]+\}/g, '');
      expect(stripped, id).not.toMatch(/[{}]/);
    }
  });

  it('has no empty message and no message that only differs by spacing from another id', () => {
    const seen = new Map<string, string>();
    for (const id of MESSAGE_IDS) {
      const text: string = EN[id];
      expect(text.trim(), id).not.toBe('');
      expect(text, id).toBe(text.trim());
      const clash = seen.get(text.toLowerCase());
      // The same short word may be used for different things (for example a label and a family),
      // but a long sentence repeated under two ids is a copy that will drift.
      if (text.length > 40) expect(clash, `${id} repeats ${String(clash)}`).toBeUndefined();
      seen.set(text.toLowerCase(), id);
    }
  });

  it('reads slot names in order of first appearance', () => {
    expect(slotsOf('{a} then {b} then {a}')).toEqual(['a', 'b']);
    expect(slotsOf('nothing here')).toEqual([]);
  });
});
