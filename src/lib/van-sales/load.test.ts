import { describe, expect, it } from 'vitest';
import { LOAD_KINDS, LOAD_KIND_WORDS, LOAD_STATE_WORDS, loadSteps, mergeSuggestion, plannerRows, readSign, shortWords, suggestLoad, type PlannerRow } from './load';

const m = (o: Record<string, number>): Map<string, number> => new Map(Object.entries(o));

describe('suggested load', () => {
  it('tops the van up to its par level', () => {
    const rows = suggestLoad({ par: m({ a: 50, b: 20 }), onVan: m({ a: 18, b: 20 }), drops: m({}) });
    expect(rows).toEqual([{ productId: 'a', par: 50, onVan: 18, drops: 0, wanted: 32, loadable: 32, short: 0 }]);
  });
  it('adds the pre-sold drops on top of the par top-up, even for a product with no par', () => {
    const rows = suggestLoad({ par: m({ a: 10 }), onVan: m({ a: 4 }), drops: m({ a: 3, z: 6 }) });
    expect(rows.map((r) => [r.productId, r.wanted])).toEqual([['a', 9], ['z', 6]]);
  });
  it('does not load when the van already holds more than par and nothing is to be dropped', () => {
    expect(suggestLoad({ par: m({ a: 10 }), onVan: m({ a: 40 }), drops: m({}) })).toEqual([]);
  });
  it('says what the warehouse cannot give', () => {
    const [row] = suggestLoad({ par: m({ a: 30 }), onVan: m({}), drops: m({}), warehouse: m({ a: 12.5 }) });
    expect(row).toMatchObject({ wanted: 30, loadable: 12.5, short: 17.5 });
    expect(row === undefined ? null : shortWords(row)).toBe('17.5 short: 30 wanted, 12.5 can be loaded.');
    expect(shortWords({ wanted: 5, loadable: 5, short: 0 })).toBeNull();
  });
  it('treats a product the warehouse does not list as none, and ignores negative figures', () => {
    const [row] = suggestLoad({ par: m({ a: 5 }), onVan: m({ a: -3 }), drops: m({}), warehouse: m({}) });
    expect(row).toMatchObject({ wanted: 5, loadable: 0, short: 5 });
  });
  it('keeps fractions exact', () => {
    const [row] = suggestLoad({ par: m({ a: 0.3 }), onVan: m({ a: 0.1 }), drops: m({}) });
    expect(row?.wanted).toBe(0.2);
  });
});


describe('a load once it is made', () => {
  it('has words for each kind and each step of its transfer', () => {
    for (const k of LOAD_KINDS) expect(LOAD_KIND_WORDS[k].length).toBeGreaterThan(3);
    for (const s of ['draft', 'requested', 'approved', 'shipped', 'partly_received', 'received', 'closed', 'cancelled']) expect(LOAD_STATE_WORDS[s]?.length ?? 0, s).toBeGreaterThan(3);
  });

  it('offers only the step that is next: approve (where wanted), send, sign, or call it off before it leaves', () => {
    const at = (state: string, over: Partial<{ signed: boolean; cancelled: boolean; needsApproval: boolean }> = {}) => loadSteps({ state, signed: false, cancelled: false, needsApproval: false, ...over });
    expect(at('requested')).toEqual({ approve: false, ship: true, sign: false, cancel: true });
    expect(at('requested', { needsApproval: true })).toEqual({ approve: true, ship: false, sign: false, cancel: true });
    expect(at('approved', { needsApproval: true })).toEqual({ approve: false, ship: true, sign: false, cancel: true });
    expect(at('shipped')).toEqual({ approve: false, ship: false, sign: true, cancel: false });
    expect(at('partly_received')).toEqual({ approve: false, ship: false, sign: true, cancel: false });
    expect(at('shipped', { signed: true })).toEqual({ approve: false, ship: false, sign: false, cancel: false });
    expect(at('received', { signed: true })).toEqual({ approve: false, ship: false, sign: false, cancel: false });
    expect(at('requested', { cancelled: true })).toEqual({ approve: false, ship: false, sign: false, cancel: false });
  });

  it('reads a signing as everything that was sent, or the quantities counted', () => {
    expect(readSign({})).toEqual({ ok: true, sign: { entries: null, reason: null } });
    expect(readSign({ reason: '  Rep signed on paper ' })).toEqual({ ok: true, sign: { entries: null, reason: 'Rep signed on paper' } });
    expect(readSign({ entries: [{ productId: 'prod_a', quantity: 3 }, { productId: 'prod_b', quantity: '0.5' }] })).toEqual({ ok: true, sign: { entries: [{ productId: 'prod_a', quantity: 3 }, { productId: 'prod_b', quantity: 0.5 }], reason: null } });
    expect(readSign({ entries: [{ productId: 'prod_a', quantity: 0 }] })).toMatchObject({ ok: true });
  });
  it.each([
    [{ entries: 'x' }, 'could not be read'],
    [{ entries: [{ productId: '', quantity: 1 }] }, 'from the load'],
    [{ entries: [{ productId: 'a', quantity: 1 }, { productId: 'a', quantity: 2 }] }, 'counted once'],
    [{ entries: [{ productId: 'a', quantity: -1 }] }, 'less than nothing'],
    [{ entries: [{ productId: 'a', quantity: 'lots' }] }, 'less than nothing'],
  ])('refuses %j in words', (raw, words) => {
    const r = readSign(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });
});


describe('the planner\'s list when the warehouse is changed', () => {
  const row = (productId: string, over: Partial<PlannerRow> = {}): PlannerRow => ({ productId, name: productId, par: 10, onVan: 0, available: 50, quantity: '10', short: 0, edited: false, ...over });
  const fresh = [row('a', { available: 7, quantity: '7', short: 3 }), row('b', { available: 40 }), row('c')];

  it('turns a suggestion into lines to edit', () => {
    expect(plannerRows([{ productId: 'a', productName: 'Soda', par: 20, onVan: 4, available: 100, loadable: 16, short: 0 }])).toEqual([{ productId: 'a', name: 'Soda', par: 20, onVan: 4, available: 100, quantity: '16', short: 0, edited: false }]);
  });
  it('takes the new warehouse\'s figures but keeps a quantity the planner typed', () => {
    const merged = mergeSuggestion(fresh, [row('a', { quantity: '5', edited: true }), row('b')], new Set());
    expect(merged.find((r) => r.productId === 'a')).toMatchObject({ quantity: '5', edited: true, available: 7, short: 3 });
    expect(merged.find((r) => r.productId === 'b')).toMatchObject({ quantity: '10', available: 40, edited: false });
  });
  it('keeps products added by hand and products taken off, and drops a product the new suggestion no longer has', () => {
    const merged = mergeSuggestion(fresh, [row('hand', { par: null, quantity: '3', edited: true }), row('gone')], new Set(['c']));
    expect(merged.map((r) => r.productId)).toEqual(['a', 'b', 'hand']);
    expect(merged.find((r) => r.productId === 'hand')).toMatchObject({ quantity: '3', par: null });
  });
  it('lets a hand-added product become the suggestion\'s, with the typed quantity', () => {
    const merged = mergeSuggestion(fresh, [row('b', { par: null, quantity: '9', edited: true })], new Set());
    expect(merged.filter((r) => r.productId === 'b')).toHaveLength(1);
    expect(merged.find((r) => r.productId === 'b')).toMatchObject({ quantity: '9', par: 10 });
  });
  it('changes nothing it was not asked to when nothing was edited', () => {
    expect(mergeSuggestion(fresh, [row('a'), row('b')], new Set())).toEqual(fresh);
  });
});
