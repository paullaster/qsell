import { describe, expect, it } from 'vitest';
import { backProblem, reconcileProblem, unloadProblem } from './back';

describe('saying the day is back', () => {
  const ok = { dayStatus: 'out', visits: [{ name: 'Duka 1', status: 'done' }, { name: 'Duka 2', status: 'skipped' }, { name: 'Duka 3', status: 'closed_shop' }], openDeliveries: [] };
  it('needs every visit finished or skipped and every delivery dealt with', () => {
    expect(backProblem(ok)).toBeNull();
    expect(backProblem({ ...ok, visits: [] })).toBeNull();
  });
  it('names what is in the way, in the singular and the plural', () => {
    expect(backProblem({ ...ok, visits: [...ok.visits, { name: 'Mama Njeri', status: 'planned' }] })).toBe('Mama Njeri has not been finished. Finish or skip that visit first.');
    expect(backProblem({ ...ok, visits: [{ name: 'A', status: 'planned' }, { name: 'B', status: 'arrived' }, { name: 'C', status: 'planned' }, { name: 'D', status: 'planned' }] })).toBe('A, B, C and 1 more have not been finished. Finish or skip those visits first.');
    expect(backProblem({ ...ok, openDeliveries: ['ORD-1'] })).toBe('ORD-1 has not been delivered. Deliver it, or say why not.');
    expect(backProblem({ ...ok, openDeliveries: ['ORD-1', 'ORD-2'] })).toContain('have not been delivered');
  });
  it('is only for a day that is out', () => {
    expect(backProblem({ ...ok, dayStatus: 'planned' })).toContain('out on the route');
    expect(backProblem({ ...ok, dayStatus: 'returning' })).toContain('out on the route');
  });
});

describe('unloading the van', () => {
  const ok = { dayStatus: 'returning', hasVan: true, productsOnVan: 3, unload: 'none' as const };
  it('is for a van with stock on it, once the day is back, and only once', () => {
    expect(unloadProblem(ok)).toBeNull();
    expect(unloadProblem({ ...ok, hasVan: false })).toContain('no van');
    expect(unloadProblem({ ...ok, dayStatus: 'out' })).toContain('once the day is back');
    expect(unloadProblem({ ...ok, unload: 'asked' })).toContain('already being unloaded');
    expect(unloadProblem({ ...ok, productsOnVan: 0 })).toContain('empty');
  });
});

describe('starting to settle the day', () => {
  const ok = { dayStatus: 'returning', hasVan: true, productsOnVan: 2, unload: 'received' as const };
  it('needs a van with stock to have been unloaded and received', () => {
    expect(reconcileProblem(ok)).toBeNull();
    expect(reconcileProblem({ ...ok, unload: 'on_its_way' })).toContain('not been received');
    expect(reconcileProblem({ ...ok, unload: 'asked' })).toContain('not been received');
    expect(reconcileProblem({ ...ok, unload: 'none' })).toContain('Unload it first');
  });
  it('needs nothing of an empty van or a day with no van', () => {
    expect(reconcileProblem({ ...ok, unload: 'none', productsOnVan: 0 })).toBeNull();
    expect(reconcileProblem({ ...ok, hasVan: false, unload: 'none', productsOnVan: 0 })).toBeNull();
  });
  it('is only for a day that is back', () => {
    expect(reconcileProblem({ ...ok, dayStatus: 'out' })).toContain('once the day is back');
  });
});
