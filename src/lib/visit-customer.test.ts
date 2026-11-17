import { describe, expect, it } from 'vitest';
import { customerVisitWords } from './visit-customer';

describe('what a customer is told about a visit', () => {
  it('has words for every state a visit goes through', () => {
    const states = ['scheduled', 'crew_assigned', 'on_site', 'completed', 'signed_off', 'cancelled'].map((s) => customerVisitWords(s).state);
    expect(states).toEqual(['booked', 'booked', 'with_you', 'done', 'signed_off', 'cancelled']);
    for (const s of ['scheduled', 'crew_assigned', 'on_site', 'completed', 'signed_off', 'cancelled']) expect(customerVisitWords(s).words.length).toBeGreaterThan(8);
  });

  it('reads an unknown status as booked, and never gives a crew, a phone number or a note', () => {
    expect(customerVisitWords('something_new')).toEqual({ state: 'booked', words: 'Booked.' });
    expect(Object.keys(customerVisitWords('on_site')).sort()).toEqual(['state', 'words']);
  });
});
