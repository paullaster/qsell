import { describe, expect, it } from 'vitest';
import { shortWords, suggestLoad } from './load';

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
