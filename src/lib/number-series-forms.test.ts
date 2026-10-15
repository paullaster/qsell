import { describe, expect, it } from 'vitest';
import { defaultBinding, overridesOf, seriesCodeOf, bindingQuestion, boundWords, exampleNumber, lineFormFrom, lineValues, resetLabel, seriesFormFrom, seriesPatch, withMode, withToken } from './number-series-forms';

const line = { branchId: null, startsOn: '2026-01-01', endsOn: null, prefix: 'INV-', suffix: '', digits: 4, startNo: 1, endNo: null, increment: 1, warnAt: null, reset: 'yearly' as const };

describe('number series forms', () => {
  it('writes an example, or nothing when the pattern cannot be written', () => {
    expect(exampleNumber({ prefix: 'INV-', suffix: '', digits: 4 }, 7, '2026-03-01', null, '2026-03-01')).toBe('INV-0007');
    expect(exampleNumber({ prefix: 'INV-', suffix: '', digits: 2 }, 700, '2026-03-01', null, '2026-03-01')).toBeNull();
    expect(exampleNumber({ prefix: 'A-{BRANCH}-', suffix: '', digits: 3 }, 1, '', 'MSA', '2026-03-01')).toBe('A-MSA-001');
  });

  it('starts a new line at the first of this year, yearly', () => {
    const f = lineFormFrom(null, '2026-10-15');
    expect(f).toMatchObject({ startsOn: '2026-01-01', digits: '6', startNo: '1', reset: 'yearly', branchId: '', endNo: '' });
  });

  it('fills the form from a line and sends it back as numbers', () => {
    const f = lineFormFrom({ ...line, endNo: 999, warnAt: 900, branchId: 'b1' }, '2026-10-15');
    expect(f).toMatchObject({ endNo: '999', warnAt: '900', branchId: 'b1' });
    expect(lineValues(f)).toEqual({ branchId: 'b1', startsOn: '2026-01-01', endsOn: null, prefix: 'INV-', suffix: '', digits: 4, startNo: 1, endNo: 999, increment: 1, warnAt: 900, reset: 'yearly' });
    expect(lineValues(lineFormFrom(line, '2026-10-15'))).toMatchObject({ endNo: null, warnAt: null, branchId: null });
  });

  it('keeps settings honest when the mode changes', () => {
    const form = seriesFormFrom({ description: 'x', mode: 'gap_free', manualAllowed: false, defaultNumbers: true, dateOrder: true, blockSize: 50, isActive: true });
    expect(withMode(form, 'allow_gaps').dateOrder).toBe(false);
    expect(seriesPatch(withMode(form, 'allow_gaps')).dateOrder).toBe(false);
    expect(seriesPatch(form).dateOrder).toBe(true);
    expect(seriesPatch({ ...form, blockSize: 'abc' }).blockSize).toBe(50);
    expect(seriesPatch({ ...form, blockSize: '200' }).blockSize).toBe(200);
  });

  it('words things', () => {
    expect(resetLabel('monthly')).toBe('Every month');
    expect(withToken('INV-', 'YY')).toBe('INV-{YY}');
    expect(boundWords([{ label: 'Invoice', branchCode: null }, { label: 'Receipt', branchCode: 'NBO' }])).toBe('Invoice, Receipt (NBO)');
    expect(bindingQuestion({ kindLabel: 'Invoice', branchLabel: 'all branches', seriesCode: 'INV' })).toBe('Number invoice (all branches) with INV?');
    expect(bindingQuestion({ kindLabel: 'Invoice', branchLabel: 'Nairobi', seriesCode: null })).toBe('Stop using a specific series for invoice (Nairobi)?');
  });
});

describe('bindings', () => {
  const rows = [
    { documentKind: 'invoice', branchId: null, branchLabel: null, seriesId: 's1', seriesLabel: 'INV — Invoices' },
    { documentKind: 'invoice', branchId: 'b1', branchLabel: 'Nairobi (NBO)', seriesId: 's2', seriesLabel: 'NBI — Nairobi invoices' },
    { documentKind: 'receipt', branchId: null, branchLabel: null, seriesId: 's3', seriesLabel: 'RCT — Receipts' },
  ];
  it('finds the default and the branch overrides of a kind', () => {
    expect(defaultBinding(rows, 'invoice')?.seriesId).toBe('s1');
    expect(defaultBinding(rows, 'quote')).toBeUndefined();
    expect(overridesOf(rows, 'invoice').map((r) => r.branchId)).toEqual(['b1']);
    expect(overridesOf(rows, 'receipt')).toEqual([]);
  });
  it('takes the code out of a series label', () => {
    expect(seriesCodeOf('INV — Invoices')).toBe('INV');
    expect(seriesCodeOf('PLAIN')).toBe('PLAIN');
  });
});
