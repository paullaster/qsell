import { describe, expect, it } from 'vitest';
import { callOffProblems, checkContractHeader, checkContractLine, emptyContractLine, remainingQuantity, type ContractLineState } from './vendor-contract';

const header = { vendorId: 'v', categoryId: 'c', title: 'Panels 2027', currency: 'KES', validFrom: '2027-01-01', validTo: '2027-12-31', maxValue: '', terms: '' };
const line: ContractLineState = { id: 'l1', description: 'Panel', unitPrice: '100', discountPercent: '0', taxRate: '16', maxQuantity: '100', usedQuantity: 60 };
const base = { status: 'active', validFrom: '2027-01-01', validTo: '2027-12-31', orderDate: '2027-06-01', maxValueCents: null, usedValueCents: 0, lines: [line] };

describe('vendor contracts', () => {
  it('checks the header and the lines', () => {
    expect(checkContractHeader(header)).toEqual({});
    expect(checkContractHeader({ ...header, validTo: '2026-12-31' }).validTo).toMatch(/before/);
    expect(Object.keys(checkContractHeader({ ...header, vendorId: '', title: 'x', maxValue: '0' })).sort()).toEqual(['maxValue', 'title', 'vendorId']);
    expect(checkContractLine({ ...emptyContractLine(), description: 'Panel', unitPrice: '100' })).toEqual({});
    expect(Object.keys(checkContractLine({ ...emptyContractLine(), description: '', unitPrice: 'x', maxQuantity: '0' })).sort()).toEqual(['description', 'maxQuantity', 'unitPrice']);
  });
  it('works out what is left on a line', () => {
    expect(remainingQuantity('100', 60)).toBe(40);
    expect(remainingQuantity('100', 120)).toBe(0);
    expect(remainingQuantity(null, 5)).toBeNull();
  });
  it('lets an order fit within the lines, the period and the ceiling, and says plainly when it does not', () => {
    expect(callOffProblems({ ...base, asked: [{ contractLineId: 'l1', quantity: '40' }] })).toEqual([]);
    expect(callOffProblems({ ...base, asked: [{ contractLineId: 'l1', quantity: '40.001' }] })[0]).toMatch(/only 40 is left/);
    expect(callOffProblems({ ...base, status: 'closed', asked: [{ contractLineId: 'l1', quantity: '1' }] })[0]).toMatch(/not in force/);
    expect(callOffProblems({ ...base, orderDate: '2028-01-01', asked: [{ contractLineId: 'l1', quantity: '1' }] })[0]).toMatch(/ended on 2027-12-31/);
    expect(callOffProblems({ ...base, orderDate: '2026-12-31', asked: [{ contractLineId: 'l1', quantity: '1' }] })[0]).toMatch(/starts on/);
    expect(callOffProblems({ ...base, asked: [] })[0]).toMatch(/Choose what/);
    expect(callOffProblems({ ...base, asked: [{ contractLineId: 'zz', quantity: '1' }] })[0]).toMatch(/not on the contract/);
    expect(callOffProblems({ ...base, asked: [{ contractLineId: 'l1', quantity: '1' }, { contractLineId: 'l1', quantity: '1' }] }).join(' ')).toMatch(/twice/);
    // 10 panels at 100 plus 16% tax is 1160; the ceiling leaves 1000.
    expect(callOffProblems({ ...base, maxValueCents: 500_000, usedValueCents: 400_000, asked: [{ contractLineId: 'l1', quantity: '10' }] })[0]).toMatch(/1160\.00.*1000\.00/);
    expect(callOffProblems({ ...base, maxValueCents: 500_000, usedValueCents: 380_000, asked: [{ contractLineId: 'l1', quantity: '10' }] })).toEqual([]);
  });
});
