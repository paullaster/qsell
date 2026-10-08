import { afterEach, describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { PdfKitInvoiceAdapter } from './pdfkit-invoice.adapter';
import { quotePdfItems } from '@/server/domains/quotes/pdf-items';

/** What the printed quote says, read from the text the PDF was asked to draw. */
async function printed(showLines: boolean): Promise<string[]> {
  const drawn: string[] = [];
  const real = PDFDocument.prototype.text;
  vi.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (
    this: unknown,
    text: unknown,
    ...rest: unknown[]
  ) {
    drawn.push(String(text));
    return (real as (...a: unknown[]) => unknown).call(this, text, ...rest) as never;
  } as never);
  const items = quotePdfItems({
    lines: [
      {
        sectionId: 'A',
        sku: 'x1',
        description: 'Solar panel',
        quantity: '2',
        unitPrice: '500',
        lineAmount: '1000',
      },
      {
        sectionId: 'A',
        sku: 'x2',
        description: 'Inverter',
        quantity: '1',
        unitPrice: '800',
        lineAmount: '800',
      },
      {
        sectionId: null,
        sku: 'i1',
        description: 'Delivery',
        quantity: '1',
        unitPrice: '100',
        lineAmount: '100',
      },
    ],
    sections: [{ id: 'A', title: 'Power kit', description: null, showLines }],
  });
  await new PdfKitInvoiceAdapter().generate({
    documentType: 'sales_quote',
    invoiceNumber: 'QTE-1',
    issuedAt: new Date().toISOString(),
    orderId: 'q1',
    orderNumber: 'QTE-1',
    currency: 'KES',
    company: {
      legalName: 'Co',
      tradingName: 'Co',
      email: 'a@b.c',
      phone: '1',
      address: 'x',
      kraPin: 'P',
      invoicePrefix: 'I',
      primaryColor: '#111111',
      accentColor: '#222222',
    },
    customer: {
      name: 'Buyer',
      email: '',
      phone: '',
      shippingAddress: { street: '', city: '', countyOrState: '', country: '' },
    },
    items,
    subtotal: 1900,
    tax: 0,
    taxLabel: 'Tax',
    shippingFee: 0,
    totalAmount: 1900,
    paymentMethod: 'mpesa_daraja',
    paymentReference: null,
    paymentStatus: 'unpaid',
  } as never);
  return drawn;
}

describe('a printed quote', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows a collapsed section as its title and total only', async () => {
    const text = await printed(false);
    expect(text).toContain('Power kit');
    expect(text.some((t) => t.includes('1,800'))).toBe(true);
    expect(text).toContain('Delivery');
    expect(text).not.toContain('Solar panel');
    expect(text).not.toContain('Inverter');
  });

  it('lists the section’s items under it when it is set to stay expanded', async () => {
    const text = await printed(true);
    expect(text).toContain('Power kit');
    expect(text).toContain('Solar panel');
    expect(text).toContain('Inverter');
    expect(text.some((t) => t.includes('1,800'))).toBe(true);
    // Title first, then its items.
    expect(text.indexOf('Power kit')).toBeLessThan(text.indexOf('Solar panel'));
  });
});
