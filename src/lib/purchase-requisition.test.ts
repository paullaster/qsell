import { describe, expect, it } from 'vitest';
import { checkRequisitionHeader, checkRequisitionLine, emptyRequisitionLine, estimatedTotalCents } from './purchase-requisition';

const header = { title: 'Office chairs', purpose: 'Eight new hires', categoryId: 'c', currency: 'KES', neededBy: '2026-11-30' };

describe('purchase requisitions', () => {
  it('checks the header', () => {
    expect(checkRequisitionHeader(header, '2026-10-25')).toEqual({});
    expect(Object.keys(checkRequisitionHeader({ ...header, title: 'x', categoryId: '', currency: '' }, '2026-10-25')).sort()).toEqual(['categoryId', 'currency', 'title']);
    expect(checkRequisitionHeader({ ...header, neededBy: '2026-10-01' }, '2026-10-25').neededBy).toMatch(/past/);
    expect(checkRequisitionHeader({ ...header, neededBy: '' }, '2026-10-25')).toEqual({});
  });
  it('checks lines and adds up estimates in cents', () => {
    expect(checkRequisitionLine({ ...emptyRequisitionLine(), description: 'Chair', quantity: '8', estimatedUnitPrice: '4500' })).toEqual({});
    expect(Object.keys(checkRequisitionLine({ ...emptyRequisitionLine(), description: '', quantity: '0', unit: '', estimatedUnitPrice: 'x' })).sort()).toEqual(['description', 'estimatedUnitPrice', 'quantity', 'unit']);
    expect(estimatedTotalCents([{ ...emptyRequisitionLine(), quantity: '8', estimatedUnitPrice: '4500' }, { ...emptyRequisitionLine(), quantity: '2.5', estimatedUnitPrice: '10.10' }, { ...emptyRequisitionLine(), quantity: '3' }])).toBe(3_600_000 + 2525);
  });
});
