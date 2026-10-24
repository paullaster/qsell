import { describe, expect, it } from 'vitest';
import { blankQuoteLine, checkQuoteLines, checkRfqHeader, checkRfqLine, compare, emptyRfqHeader, emptyRfqLine, isOpenForQuotes, quoteTotals, vendorStage } from './rfq';

describe('request header and lines', () => {
  const ok = { ...emptyRfqHeader(), title: 'Solar panels for the depot', categoryId: 'c1', deadline: '2026-12-01T17:00', currency: 'KES' };
  it('accepts a good header and names each problem', () => {
    expect(checkRfqHeader(ok)).toEqual({});
    expect(Object.keys(checkRfqHeader({ ...emptyRfqHeader() })).sort()).toEqual(['categoryId', 'currency', 'deadline', 'title']);
    expect(checkRfqHeader({ ...ok, validityDays: '0' }).validityDays).toBeDefined();
    expect(checkRfqHeader({ ...ok, estimatedValue: '12,5' }).estimatedValue).toBeDefined();
  });
  it('checks a line', () => {
    expect(checkRfqLine({ ...emptyRfqLine(), description: '5 kW inverter', quantity: '2.5' })).toEqual({});
    expect(Object.keys(checkRfqLine({ ...emptyRfqLine(), description: 'x', quantity: '0' })).sort()).toEqual(['description', 'quantity']);
  });
  it('is open only while issued and before the deadline', () => {
    const d = new Date('2026-12-01T17:00:00Z');
    expect(isOpenForQuotes('issued', d, new Date('2026-12-01T16:59:00Z'))).toBe(true);
    expect(isOpenForQuotes('issued', d, new Date('2026-12-01T17:01:00Z'))).toBe(false);
    expect(isOpenForQuotes('closed', d, new Date('2026-11-30T00:00:00Z'))).toBe(false);
  });
});

describe('quote lines', () => {
  const asked = [{ id: 'a', description: 'Inverter', quantity: 4 }, { id: 'b', description: 'Cable', quantity: 100 }];
  const line = (id: string, over: Partial<ReturnType<typeof blankQuoteLine>> = {}) => ({ ...blankQuoteLine(id, id === 'a' ? 4 : 100), unitPrice: '10', ...over });
  const rules = { allowPartial: false, allowAlternatives: false };
  it('needs every line answered and one real bid to submit; a draft may be partly filled', () => {
    expect(checkQuoteLines(asked, [line('a')], rules, false)).toEqual({});
    expect(checkQuoteLines(asked, [line('a')], rules, true)['b.line']).toBeDefined();
    expect(checkQuoteLines(asked, [line('a', { noBid: true }), line('b', { noBid: true })], rules, true).lines).toBeDefined();
    expect(checkQuoteLines(asked, [line('a'), line('b', { noBid: true })], rules, true)).toEqual({});
  });
  it('checks price, quantity, partial and alternatives', () => {
    expect(checkQuoteLines(asked, [line('a', { unitPrice: 'free' }), line('b')], rules, true)['a.unitPrice']).toBeDefined();
    expect(checkQuoteLines(asked, [line('a', { quantity: '3' }), line('b')], rules, true)['a.quantity']).toMatch(/partial/);
    expect(checkQuoteLines(asked, [line('a', { quantity: '3' }), line('b')], { ...rules, allowPartial: true }, true)).toEqual({});
    expect(checkQuoteLines(asked, [line('a', { quantity: '5' }), line('b')], { ...rules, allowPartial: true }, true)['a.quantity']).toMatch(/more than/);
    expect(checkQuoteLines(asked, [line('a'), line('b'), line('a', { isAlternative: true })], rules, true)['a:alt.line']).toBeDefined();
    expect(checkQuoteLines(asked, [line('a'), line('b'), line('a', { isAlternative: true })], { ...rules, allowAlternatives: true }, true)).toEqual({});
    expect(checkQuoteLines(asked, [line('zzz')], rules, false)['zzz.line']).toBeDefined();
  });
  it('totals in cents, without alternatives or lines not bid, with tax', () => {
    const t = quoteTotals([line('a', { unitPrice: '1250.50', taxRate: '16' }), line('b', { unitPrice: '2.25' }), line('b', { isAlternative: true, unitPrice: '1' }), { ...line('a'), rfqLineId: 'c', noBid: true }]);
    expect(t.subtotal).toBe(500200 + 22500);
    expect(t.tax).toBe(80032);
    expect(t.total).toBe(t.subtotal + t.tax);
  });
});

describe('what a vendor sees', () => {
  const base = { rfqStatus: 'issued', inviteStatus: 'invited', decision: 'pending', hasSubmitted: false, hasDraft: false, wasAwarded: false };
  it('maps each stage', () => {
    expect(vendorStage(base)).toBe('new');
    expect(vendorStage({ ...base, inviteStatus: 'opened' })).toBe('in_progress');
    expect(vendorStage({ ...base, hasDraft: true })).toBe('in_progress');
    expect(vendorStage({ ...base, hasSubmitted: true })).toBe('submitted');
    expect(vendorStage({ ...base, hasSubmitted: true, decision: 'revision_requested' })).toBe('revision_requested');
    expect(vendorStage({ ...base, rfqStatus: 'closed', hasSubmitted: true, decision: 'revision_requested' })).toBe('revision_requested');
    expect(vendorStage({ ...base, rfqStatus: 'closed', hasSubmitted: true })).toBe('under_evaluation');
    expect(vendorStage({ ...base, rfqStatus: 'closed' })).toBe('expired');
    expect(vendorStage({ ...base, rfqStatus: 'awarded', hasSubmitted: true, wasAwarded: true })).toBe('awarded');
    expect(vendorStage({ ...base, rfqStatus: 'awarded', hasSubmitted: true })).toBe('not_awarded');
    expect(vendorStage({ ...base, rfqStatus: 'awarded', hasSubmitted: true, decision: 'rejected' })).toBe('rejected');
    expect(vendorStage({ ...base, inviteStatus: 'declined' })).toBe('declined');
    expect(vendorStage({ ...base, rfqStatus: 'cancelled', hasSubmitted: true })).toBe('cancelled');
  });
});

describe('comparison sheet', () => {
  const cell = (price: number, qty: number, lead: number | null = null) => ({ noBid: false, unitPrice: price, quantity: qty, lineTotal: price * qty, leadTimeDays: lead });
  const no = { noBid: true, unitPrice: 0, quantity: 0, lineTotal: 0, leadTimeDays: null };
  it('finds the lowest per line and the lowest complete total', () => {
    const r = compare(['a', 'b'], [
      { vendorId: 'v1', cells: { a: cell(100, 4), b: cell(10, 10) }, taxTotal: 0 },
      { vendorId: 'v2', cells: { a: cell(90, 4), b: no }, taxTotal: 0 },
      { vendorId: 'v3', cells: { a: cell(95, 4), b: cell(10, 10) }, taxTotal: 5 },
    ]);
    expect(r.rows).toEqual([{ lineId: 'a', lowest: ['v2'] }, { lineId: 'b', lowest: ['v1', 'v3'] }]);
    expect(r.vendors.map((v) => [v.vendorId, v.total, v.complete])).toEqual([['v1', 500, true], ['v2', 360, false], ['v3', 485, true]]);
    expect(r.lowestComplete).toEqual(['v3']);
  });
  it('has no lowest when nobody quoted every line', () => {
    expect(compare(['a'], [{ vendorId: 'v', cells: { a: no }, taxTotal: 0 }]).lowestComplete).toEqual([]);
  });
});
