import { describe, expect, it } from 'vitest';
import { SCOPE_WORDS, describeRules, feedWords, toForm, toRules, type Rules } from './bank-match-form';

const rules: Rules = { reference: 'auto', minRefLength: 5, amountToleranceCents: 0, dateWindowDays: 3, phone: 'off', name: 'off', nameMinScore: 0.6, maxProposals: 5 };

describe('the matching rules form', () => {
  it('starts from the rules, with the tolerance in money', () => {
    expect(toForm({ ...rules, amountToleranceCents: 1550 })).toMatchObject({ amountTolerance: '15.50', dateWindowDays: '3', nameMinScore: '0.6' });
  });

  it('sends whole numbers as numbers and the tolerance in cents, and what is not a number as one the server will refuse', () => {
    const back = toRules({ ...toForm(rules), amountTolerance: '0.5', dateWindowDays: '7' });
    expect(back).toMatchObject({ amountToleranceCents: 50, dateWindowDays: 7, minRefLength: 5, maxProposals: 5, reference: 'auto' });
    expect(Number.isNaN(toRules({ ...toForm(rules), dateWindowDays: '3.5' }).dateWindowDays)).toBe(true);
    expect(Number.isNaN(toRules({ ...toForm(rules), amountTolerance: 'abc' }).amountToleranceCents)).toBe(true);
    expect(toRules({ ...toForm(rules), amountTolerance: '' }).amountToleranceCents).toBe(0);
  });

  it('says in a sentence what the rules do', () => {
    expect(describeRules(rules)).toBe('A line quoting our reference with the exact amount is matched by itself; same amount within 3 days is suggested.');
    expect(describeRules({ ...rules, reference: 'off', phone: 'auto', name: 'propose', amountToleranceCents: 25, dateWindowDays: 1 })).toBe("Our references on a line are ignored; a customer's phone number on a line with the exact amount closes it by itself; a payer's name that resembles the customer's is suggested; same amount (give or take 0.25) within 1 day is suggested.");
    expect(SCOPE_WORDS.standard).toContain('standard');
  });
});

describe('what a feed has done', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const base = { enabled: true, lastReceivedAt: null, lastLines: 0, receivedCount: 0, lastError: null };
  it('says when there is none, when it is off, when nothing came, and when it last came', () => {
    expect(feedWords(null, now)).toContain('No feed');
    expect(feedWords({ ...base, enabled: false }, now)).toContain('Switched off');
    expect(feedWords(base, now)).toContain('first delivery');
    expect(feedWords({ ...base, lastReceivedAt: '2026-10-17T11:58:00Z', lastLines: 1, receivedCount: 4 }, now)).toBe('Last delivery 2 minutes ago: 1 new line (4 deliveries in all).');
    expect(feedWords({ ...base, lastReceivedAt: '2026-10-17T06:00:00Z', lastLines: 12, receivedCount: 9 }, now)).toContain('6 hours ago');
    expect(feedWords({ ...base, lastReceivedAt: '2026-10-12T12:00:00Z', lastLines: 0, receivedCount: 2 }, now)).toContain('5 days ago');
  });
});
