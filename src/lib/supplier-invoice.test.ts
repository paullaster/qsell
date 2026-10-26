import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCES,
  approvalSeparation,
  canRecall,
  checkDeliveryNote,
  checkInvoiceHeader,
  checkEtims,
  checkInvoiceLine,
  etimsRefusal,
  deliveryNoteRule,
  invoiceTotals,
  matchLine,
  normaliseInvoiceNo,
  postingPlan,
  suggestLinks,
  type InvoiceHeaderForm,
  type MatchInput,
} from './supplier-invoice';

const header = (over: Partial<InvoiceHeaderForm> = {}): InvoiceHeaderForm => ({ vendorInvoiceNo: 'INV-1', invoiceDate: '2026-10-01', dueDate: '2026-10-31', notes: '', declaration: true, ...over });

describe('invoice forms', () => {
  it('accepts a good header and names each problem plainly', () => {
    expect(checkInvoiceHeader(header(), '2026-10-24')).toEqual({});
    expect(checkInvoiceHeader(header({ vendorInvoiceNo: ' ' }), '2026-10-24').vendorInvoiceNo).toMatch(/number printed/);
    expect(checkInvoiceHeader(header({ invoiceDate: '2026-11-01' }), '2026-10-24').invoiceDate).toMatch(/future/);
    expect(checkInvoiceHeader(header({ dueDate: '2026-09-01' }), '2026-10-24').dueDate).toMatch(/before the invoice date/);
    expect(checkInvoiceHeader(header({ invoiceDate: '2026-02-30' }), '2026-10-24').invoiceDate).toBeDefined();
  });
  it('checks lines and delivery notes', () => {
    expect(checkInvoiceLine({ poLineId: 'x', quantity: '2', unitPrice: '10.50' })).toEqual({});
    expect(Object.keys(checkInvoiceLine({ poLineId: '', quantity: '0', unitPrice: '-1' })).sort()).toEqual(['poLineId', 'quantity', 'unitPrice']);
    expect(checkDeliveryNote({ noteNo: 'DN-1', noteDate: '2026-10-02', fileId: 'f' }, '2026-10-24')).toEqual({});
    expect(Object.keys(checkDeliveryNote({ noteNo: '', noteDate: '', fileId: '' }, '2026-10-24')).sort()).toEqual(['fileId', 'noteDate', 'noteNo']);
  });
  it('treats numbers that differ only in spaces and case as one', () => {
    expect(normaliseInvoiceNo(' INV 001 ')).toBe(normaliseInvoiceNo('inv001'));
  });
  it('adds up in whole cents', () => {
    expect(invoiceTotals([{ quantity: '3', unitPrice: '10.10', taxRate: '16' }, { quantity: '1', unitPrice: '0.05', taxRate: '0' }])).toEqual({ subtotal: 3035, tax: 485, total: 3520 });
  });
});

describe('the delivery note rule', () => {
  it('needs no reason when a delivery note is claimed', () => {
    expect(deliveryNoteRule({ deliveryNotes: 1, orders: [{ number: 'PO-1', flagged: false, cover: false }] }).ok).toBe(true);
  });
  it('refuses a missing delivery note unless every order is flagged and covered', () => {
    const none = deliveryNoteRule({ deliveryNotes: 0, orders: [{ number: 'PO-1', flagged: false, cover: false }] });
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/not set up for advance payment/);
    const uncovered = deliveryNoteRule({ deliveryNotes: 0, orders: [{ number: 'PO-2', flagged: true, cover: false }] });
    expect(uncovered.reason).toMatch(/No advance payment has been approved/);
    expect(deliveryNoteRule({ deliveryNotes: 0, orders: [{ number: 'PO-3', flagged: true, cover: true }] })).toEqual({ ok: true, advance: true, reason: '' });
    expect(deliveryNoteRule({ deliveryNotes: 0, orders: [] }).advance).toBe(false);
  });
});

const line = (over: Partial<MatchInput> = {}): MatchInput => ({ invoiceQuantity: 10, invoiceUnitPriceCents: 10_000, invoiceTaxRate: 16, linkedQuantity: 10, orderUnitPriceCents: 10_000, orderTaxRate: 16, needsAccount: false, hasAccount: false, ...over });

describe('three-way match', () => {
  it('passes a line that agrees', () => {
    expect(matchLine(line(), DEFAULT_TOLERANCES)).toMatchObject({ status: 'ok', problems: [], priceDifferenceCents: 0 });
  });
  it('flags quantity above what is linked, and nothing linked at all', () => {
    expect(matchLine(line({ invoiceQuantity: 11 }), DEFAULT_TOLERANCES).problems[0]).toMatch(/only 10 are linked/);
    expect(matchLine(line({ linkedQuantity: 0 }), DEFAULT_TOLERANCES).problems[0]).toMatch(/No received goods/);
  });
  it('allows a quantity tolerance when one is set', () => {
    expect(matchLine(line({ invoiceQuantity: 10.2 }), { ...DEFAULT_TOLERANCES, quantityPercent: 5 }).status).toBe('ok');
  });
  it('allows a price rise within percent OR amount, and flags more', () => {
    expect(matchLine(line({ invoiceUnitPriceCents: 10_100 }), DEFAULT_TOLERANCES).status).toBe('ok');
    // 5% over on 10 units is 5,000 cents: above 2% but under the 10,000 amount.
    expect(matchLine(line({ invoiceUnitPriceCents: 10_500 }), DEFAULT_TOLERANCES).status).toBe('ok');
    const big = matchLine(line({ invoiceQuantity: 100, linkedQuantity: 100, invoiceUnitPriceCents: 10_500 }), DEFAULT_TOLERANCES);
    expect(big.status).toBe('exception');
    expect(big.priceDifferenceCents).toBe(50_000);
  });
  it('does not complain about a lower price', () => {
    expect(matchLine(line({ invoiceUnitPriceCents: 9_000 }), DEFAULT_TOLERANCES).status).toBe('ok');
  });
  it('flags a different tax rate and a missing account', () => {
    expect(matchLine(line({ invoiceTaxRate: 0 }), DEFAULT_TOLERANCES).problems[0]).toMatch(/tax rate/);
    expect(matchLine(line({ needsAccount: true }), DEFAULT_TOLERANCES).problems[0]).toMatch(/account/);
  });
});

describe('links, separation, recall, posting plan', () => {
  it('suggests links oldest first and reports the shortfall', () => {
    expect(suggestLinks(10, [{ rgnLineId: 'a', room: 4 }, { rgnLineId: 'b', room: 4 }, { rgnLineId: 'c', room: 4 }])).toEqual({ links: [{ rgnLineId: 'a', quantity: 4 }, { rgnLineId: 'b', quantity: 4 }, { rgnLineId: 'c', quantity: 2 }], shortfall: 0 });
    expect(suggestLinks(10, [{ rgnLineId: 'a', room: 3 }])).toEqual({ links: [{ rgnLineId: 'a', quantity: 3 }], shortfall: 7 });
    expect(suggestLinks(5, [{ rgnLineId: 'a', room: 0 }]).links).toEqual([]);
  });
  it('keeps the approver apart from the person who linked or checked', () => {
    expect(approvalSeparation('u1', 'u1', null)).toMatch(/another person/);
    expect(approvalSeparation('u1', 'u2', 'u1')).toMatch(/another person/);
    expect(approvalSeparation('u3', 'u2', 'u1')).toBeNull();
    expect(approvalSeparation('u3', null, null)).toBeNull();
  });
  it('lets the vendor recall only an untouched submitted invoice', () => {
    expect(canRecall('submitted', null)).toBe(true);
    expect(canRecall('submitted', '2026-10-24T10:00:00Z')).toBe(false);
    expect(canRecall('received', null)).toBe(false);
  });
  it('groups the debits and balances against the vendor', () => {
    const plan = postingPlan([{ kind: 'stock', accountId: null, netCents: 1000 }, { kind: 'stock', accountId: null, netCents: 500 }, { kind: 'account', accountId: 'a1', netCents: 200 }, { kind: 'account', accountId: 'a1', netCents: 100 }, { kind: 'account', accountId: 'a2', netCents: 0 }], 288);
    expect(plan.debits).toEqual([
      { key: 'stock', accountId: null, purpose: 'inventory_clearing', cents: 1500 },
      { key: 'account:a1', accountId: 'a1', purpose: 'account', cents: 300 },
    ]);
    expect(plan.payableCents).toBe(1500 + 300 + 288);
  });
});

describe('eTIMS details on a supplier invoice', () => {
  it('accepts a number and a secure link, and says plainly what is wrong with others', () => {
    expect(checkEtims({ etimsInvoiceNo: 'KRAINV-0001/23', etimsVerificationUrl: 'https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?x=1' })).toEqual({});
    expect(checkEtims({})).toEqual({});
    expect(checkEtims({ etimsInvoiceNo: '#1' }).etimsInvoiceNo).toMatch(/eTIMS invoice number/);
    expect(checkEtims({ etimsVerificationUrl: 'http://example.com' }).etimsVerificationUrl).toMatch(/https/);
    expect(checkEtims({ etimsVerificationUrl: 'not a link' }).etimsVerificationUrl).toBeDefined();
  });
  it('asks for the number only when the rule is on and there is tax', () => {
    expect(etimsRefusal(1600, false, {})).toBeNull();
    expect(etimsRefusal(0, true, {})).toBeNull();
    expect(etimsRefusal(1600, true, { etimsInvoiceNo: ' ' })).toMatch(/eTIMS invoice number/);
    expect(etimsRefusal(1600, true, { etimsInvoiceNo: 'KRA-1234' })).toBeNull();
  });
});
