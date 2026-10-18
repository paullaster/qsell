import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, checkRules, nameScore, nameTokens, phoneKeyOf, phoneKeysIn } from './bank-match';

describe('phone numbers in a bank line', () => {
  it('finds numbers however they are written, as their last nine digits', () => {
    expect(phoneKeysIn('MPESA from 254722123456 JANE')).toEqual(['722123456']);
    expect(phoneKeysIn('Received from +254 (722) 123-456 and 0711 987 654')).toEqual(['722123456', '711987654']);
    expect(phoneKeysIn('Invoice 12345 paid')).toEqual([]);
    expect(phoneKeysIn('ref 2547****123')).toEqual([]);
  });

  it('keys a customer phone the same way, and ignores one too short to be a number', () => {
    expect(phoneKeyOf('0722 123 456')).toBe('722123456');
    expect(phoneKeyOf('+254722123456')).toBe('722123456');
    expect(phoneKeyOf('12345')).toBeNull();
    expect(phoneKeyOf(null)).toBeNull();
  });
});

describe('how alike two names are', () => {
  it('drops titles and company endings and compares the words', () => {
    expect(nameTokens('Mr. John O\'Neil Ltd')).toEqual(['john', 'neil']);
    expect(nameScore('Jane Wanjiru', 'WANJIRU JANE')).toBe(1);
    expect(nameScore('Jane Wanjiru Kamau', 'Jane Wanjiru')).toBeCloseTo(0.8, 5);
    expect(nameScore('Jane Wanjiru', 'Bob Otieno')).toBe(0);
    expect(nameScore('', 'Jane')).toBe(0);
  });

  it('forgives one slip in a longer word, but not in a short one', () => {
    expect(nameScore('Wanjiru Kamau', 'Wanjiro Kamau')).toBe(1);
    expect(nameScore('Wanjiru Kamau', 'Wanjru Kamau')).toBe(1);
    expect(nameScore('Ann Lee', 'Anna Lee')).toBeCloseTo(0.5, 5);
    expect(nameScore('Wanjiru', 'Wambui')).toBe(0);
  });
});

describe('the rules a person sets', () => {
  const ok = { ...DEFAULT_RULES, phone: 'propose', name: 'propose' };
  it('are kept as given when they make sense', () => {
    const r = checkRules(ok);
    expect(r).toEqual({ ok: true, rules: ok });
    expect(checkRules({ ...DEFAULT_RULES })).toEqual({ ok: true, rules: DEFAULT_RULES });
  });

  it('say what is wrong in words', () => {
    const bad = (o: Record<string, unknown>) => {
      const r = checkRules({ ...ok, ...o });
      return r.ok ? 'fine' : r.error;
    };
    expect(bad({ reference: 'maybe' })).toContain('what each kind of evidence is worth');
    expect(bad({ name: 'auto' })).toContain('what each kind of evidence is worth');
    expect(bad({ minRefLength: 1 })).toContain('reference');
    expect(bad({ amountToleranceCents: -1 })).toContain('amount');
    expect(bad({ amountToleranceCents: 1.5 })).toContain('amount');
    expect(bad({ dateWindowDays: 31 })).toContain('30 days');
    expect(bad({ maxProposals: 0 })).toContain('1 and 10');
    expect(bad({ nameMinScore: 0.2 })).toContain('alike');
    expect(bad({ reference: 'off', phone: 'off', name: 'off', dateWindowDays: 0 })).toBe('fine');
  });
});
