import { describe, expect, it } from 'vitest';
import { dispositionsFor, heldAtPayment, isIssueMoment, issuesAt, returnProblem } from './stock-issue';

describe('when stock leaves', () => {
  it('knows the three moments and nothing else', () => {
    expect(['payment', 'dispatch', 'delivery'].every(isIssueMoment)).toBe(true);
    expect(isIssueMoment('never')).toBe(false);
    expect(isIssueMoment(undefined)).toBe(false);
  });

  it('issues at the step that matches the moment, and never at payment', () => {
    expect(issuesAt('dispatch', 'dispatch')).toBe(true);
    expect(issuesAt('dispatch', 'deliver')).toBe(false);
    expect(issuesAt('delivery', 'deliver')).toBe(true);
    expect(issuesAt('delivery', 'dispatch')).toBe(false);
    expect(issuesAt('payment', 'dispatch')).toBe(false);
    expect(issuesAt('payment', 'deliver')).toBe(false);
  });

  it('leaves the stock held at payment only for orders that are delivered with a document', () => {
    expect(heldAtPayment('payment', 'courier')).toBe(false);
    expect(heldAtPayment('dispatch', 'own_fleet')).toBe(true);
    expect(heldAtPayment('delivery', 'courier')).toBe(true);
    expect(heldAtPayment('dispatch', 'pickup')).toBe(false);
    expect(heldAtPayment('dispatch', 'scheduled_visit')).toBe(false);
    expect(heldAtPayment('dispatch', null)).toBe(false);
  });
});

describe('a return receipt', () => {
  const back = new Map([['a', { could: 3, issuedHere: true }], ['b', { could: 1, issuedHere: false }]]);
  it('offers what makes sense for what happened to the stock', () => {
    expect(dispositionsFor('dispatch', true)).toEqual(['restock', 'damaged']);
    expect(dispositionsFor('delivery', false)).toEqual(['keep', 'damaged']);
    expect(dispositionsFor('dispatch', false)).toEqual(['keep']);
    expect(dispositionsFor('payment', false)).toEqual(['keep']);
  });
  it('accepts good lines', () => {
    expect(returnProblem('dispatch', back, [{ productId: 'a', quantity: 3, disposition: 'restock' }, { productId: 'b', quantity: 0, disposition: 'keep' }])).toBeNull();
  });
  it('refuses nothing, an unknown product, a repeat, too much, a negative and a choice that does not fit', () => {
    expect(returnProblem('dispatch', back, [])).toMatch(/what came back/);
    expect(returnProblem('dispatch', back, [{ productId: 'z', quantity: 1, disposition: 'restock' }])).toMatch(/not on this delivery/);
    expect(returnProblem('dispatch', back, [{ productId: 'a', quantity: 1, disposition: 'restock' }, { productId: 'a', quantity: 1, disposition: 'restock' }])).toMatch(/only once/);
    expect(returnProblem('dispatch', back, [{ productId: 'a', quantity: 4, disposition: 'restock' }])).toMatch(/No more than 3/);
    expect(returnProblem('dispatch', back, [{ productId: 'a', quantity: -1, disposition: 'restock' }])).toMatch(/less than nothing/);
    expect(returnProblem('dispatch', back, [{ productId: 'a', quantity: 1, disposition: 'keep' }])).toMatch(/Choose what/);
    expect(returnProblem('dispatch', back, [{ productId: 'b', quantity: 1, disposition: 'restock' }])).toMatch(/Choose what/);
  });
});
