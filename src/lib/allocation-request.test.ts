import { describe, expect, it } from 'vitest';
import { parseAllocationRequest } from './allocation-request';

const A = '3f2b1c9e-0000-4000-8000-000000000001';
const B = '3f2b1c9e-0000-4000-8000-000000000002';

describe('parseAllocationRequest', () => {
  it('passes the two automatic choices through', () => {
    expect(parseAllocationRequest('oldest_first')).toEqual({ ok: true, value: 'oldest_first', named: false });
    expect(parseAllocationRequest('none')).toEqual({ ok: true, value: 'none', named: false });
  });
  it('turns named invoices into cents and marks them as named (they need the apply permission)', () => {
    expect(parseAllocationRequest([{ entryId: A, amount: '400.50' }, { entryId: B, amount: ' 10 ' }])).toEqual({
      ok: true,
      named: true,
      value: [{ entryId: A, amountCents: 40050 }, { entryId: B, amountCents: 1000 }],
    });
  });
  it('refuses anything else, whatever the browser sends', () => {
    for (const bad of [
      'newest_first', null, undefined, 5, {}, [], [{ entryId: 'not-an-id', amount: '1' }], [{ entryId: A, amount: '-5' }], [{ entryId: A, amount: '0' }],
      [{ entryId: A, amount: '1e3' }], [{ entryId: A, amount: '1.234' }], [{ entryId: A, amount: 12 }], [{ entryId: A }], [null], ['x'],
      [{ entryId: A, amount: '1' }, { entryId: A, amount: '2' }],
      Array.from({ length: 201 }, (_, i) => ({ entryId: `3f2b1c9e-0000-4000-8000-${String(i).padStart(12, '0')}`, amount: '1' })),
    ]) {
      expect(parseAllocationRequest(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
