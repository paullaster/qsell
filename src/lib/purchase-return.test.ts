import { describe, expect, it } from 'vitest';
import { checkReturnHeader, checkReturnLines, returnable } from './purchase-return';

const header = { returnDate: '2026-10-20', reason: 'faulty', vendorReference: '', notes: '' };

describe('purchase returns', () => {
  it('checks the header', () => {
    expect(checkReturnHeader(header, '2026-10-25')).toEqual({});
    expect(checkReturnHeader({ ...header, returnDate: '2026-11-01' }, '2026-10-25').returnDate).toMatch(/future/);
    expect(checkReturnHeader({ ...header, reason: '' }, '2026-10-25').reason).toBeDefined();
    expect(checkReturnHeader({ ...header, returnDate: '2026-02-30' }, '2026-10-25').returnDate).toBeDefined();
  });
  it('works out what can go back, and refuses more, nothing, duplicates and strangers', () => {
    expect(returnable(10, 4, 3)).toBe(3);
    expect(returnable(10, 8, 3)).toBe(0);
    const room = new Map([['a', 3], ['b', 0.5]]);
    expect(checkReturnLines([{ rgnLineId: 'a', quantity: '3' }, { rgnLineId: 'b', quantity: '0.5' }], room).problems).toEqual({});
    expect(checkReturnLines([{ rgnLineId: 'a', quantity: '3.001' }], room).problems[0]).toMatch(/Only 3/);
    expect(checkReturnLines([{ rgnLineId: 'a', quantity: '0' }], room).problems[0]).toBeDefined();
    expect(checkReturnLines([{ rgnLineId: 'a', quantity: '1' }, { rgnLineId: 'a', quantity: '1' }], room).problems[1]).toMatch(/twice/);
    expect(checkReturnLines([{ rgnLineId: 'x', quantity: '1' }], room).problems[0]).toMatch(/not on the note/);
    expect(checkReturnLines([], room).any).toBe(false);
  });
});
