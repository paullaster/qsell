import { describe, expect, it } from 'vitest';
import { buildUblOrder, parseUblInvoice, unitCodeOf } from './ubl';
import { parseXml, pick, textOf } from './xml-lite';

const order = { number: 'PO-2026-00007', issueDate: '2026-10-25', currency: 'KES', buyer: { name: 'Acme & Sons', taxId: 'P0123' }, seller: { name: 'Solar <Co>' }, expectedDate: '2026-11-10', subtotal: '1800.00', taxTotal: '288.00', total: '2088.00', lines: [{ id: '1', description: 'Solar panel 450W', quantity: '10', unit: 'each', unitPrice: '200', discountPercent: '10', taxRate: '16', net: '1800.00' }] };

const invoice = (over = '') => `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>INV-77</cbc:ID><cbc:IssueDate>2026-10-20</cbc:IssueDate><cbc:DueDate>2026-11-20</cbc:DueDate><cbc:DocumentCurrencyCode>kes</cbc:DocumentCurrencyCode><cac:OrderReference><cbc:ID>PO-2026-00007</cbc:ID></cac:OrderReference>${over}<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">4</cbc:InvoicedQuantity><cac:OrderLineReference><cbc:LineID>1</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>Solar panel 450W</cbc:Description></cac:Item><cac:Price><cbc:PriceAmount currencyID="KES">180</cbc:PriceAmount></cac:Price></cac:InvoiceLine></Invoice>`;

describe('UBL', () => {
  it('writes an order that is well formed, escaped, and carries the lines and totals', () => {
    const xml = buildUblOrder(order);
    const r = parseXml(xml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.root.name).toBe('Order');
    expect(textOf(r.root, 'ID')).toBe('PO-2026-00007');
    expect(textOf(r.root, 'BuyerCustomerParty', 'Party', 'PartyLegalEntity', 'RegistrationName')).toBe('Acme & Sons');
    expect(textOf(r.root, 'SellerSupplierParty', 'Party', 'PartyLegalEntity', 'RegistrationName')).toBe('Solar <Co>');
    expect(textOf(r.root, 'AnticipatedMonetaryTotal', 'PayableAmount')).toBe('2088.00');
    const line = pick(r.root, 'OrderLine', 'LineItem');
    expect(textOf(line, 'Price', 'PriceAmount')).toBe('180.00');
    expect(pick(line, 'Quantity')?.attrs.unitCode).toBe('C62');
  });
  it('maps units to the standard codes', () => {
    expect([unitCodeOf('kg'), unitCodeOf('Box'), unitCodeOf('mystery')]).toEqual(['KGM', 'BX', 'C62']);
  });
  it('reads an invoice, and says plainly what is wrong with one that is not usable', () => {
    const ok = parseUblInvoice(invoice());
    expect(ok).toEqual({ ok: true, invoice: { vendorInvoiceNo: 'INV-77', issueDate: '2026-10-20', dueDate: '2026-11-20', currency: 'KES', orderNumber: 'PO-2026-00007', lines: [{ id: '1', orderLineId: '1', description: 'Solar panel 450W', quantity: '4', unitCode: 'C62', unitPrice: '180.00' }] } });
    expect(parseUblInvoice('<Order/>')).toMatchObject({ ok: false, error: expect.stringMatching(/not a UBL invoice/) as string });
    expect(parseUblInvoice(invoice().replace('INV-77', ''))).toMatchObject({ ok: false });
    expect(parseUblInvoice(invoice().replace('2026-10-20', 'soon'))).toMatchObject({ ok: false });
    expect(parseUblInvoice(invoice().replace('<cac:OrderReference><cbc:ID>PO-2026-00007</cbc:ID></cac:OrderReference>', ''))).toMatchObject({ ok: false });
    expect(parseUblInvoice(invoice().replace('>4<', '>0<'))).toMatchObject({ ok: false });
    expect(parseUblInvoice(invoice().replace('>180<', '>free<'))).toMatchObject({ ok: false });
    expect(parseUblInvoice('<!DOCTYPE x><Invoice/>')).toMatchObject({ ok: false });
  });
});
