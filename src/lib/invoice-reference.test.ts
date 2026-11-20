import { describe, expect, it } from 'vitest';
import {
  invoiceLineDiscount,
  invoiceTitle,
  lineText,
  printableLines,
  type InvoiceLineView,
} from './invoice-reference';

const line = (over: Partial<InvoiceLineView> = {}): InvoiceLineView => ({
  id: 'line-1',
  name: 'Blue shirt',
  sku: 'S1',
  quantity: '2',
  unit: null,
  unitPrice: '500.00',
  total: '1000.00',
  gift: false,
  ...over,
});

describe('invoiceTitle', () => {
  it('names the invoice and the order when an invoice was issued', () => {
    expect(invoiceTitle({ documentNo: 'ORD-1', invoiceNo: 'INV-9', orderNumber: 'ORD-1' })).toEqual(
      { title: 'Invoice INV-9', order: 'Order ORD-1' },
    );
  });
  it('calls an order an order, not an invoice, when no invoice number exists', () => {
    expect(invoiceTitle({ documentNo: 'ORD-1', invoiceNo: null, orderNumber: 'ORD-1' })).toEqual({
      title: 'Order ORD-1',
      order: null,
    });
  });
  it('falls back to the ledger number for an entry with no order', () => {
    expect(invoiceTitle({ documentNo: 'OPEN-3', invoiceNo: null, orderNumber: null })).toEqual({
      title: 'OPEN-3',
      order: null,
    });
    expect(invoiceTitle({ documentNo: 'OPEN-3', invoiceNo: '', orderNumber: '' })).toEqual({
      title: 'OPEN-3',
      order: null,
    });
  });
});

describe('lineText and printableLines', () => {
  it('keeps the unit a line was sold in and marks free gifts', () => {
    expect(lineText(line())).toBe('2 × Blue shirt');
    expect(lineText(line({ quantity: '1.5', unit: 'kg', name: 'Sugar' }))).toBe('1.5 kg × Sugar');
    expect(lineText(line({ gift: true }))).toBe('2 × Blue shirt (free gift)');
  });
  it('caps long lists and says how many were left out', () => {
    const many = Array.from({ length: 15 }, (_, i) => line({ name: `Item ${String(i)}` }));
    const { shown, more } = printableLines(many, 12);
    expect(shown).toHaveLength(12);
    expect(more).toBe(3);
    expect(printableLines(many.slice(0, 2)).more).toBe(0);
  });
});

describe('invoiceLineDiscount', () => {
  it('returns no discount when the price explanation has none', () => {
    expect(invoiceLineDiscount(null, '1000.00')).toEqual({
      savedAmount: null,
      discountLabel: null,
    });
    expect(invoiceLineDiscount({ discounts: null }, '1000.00')).toEqual({
      savedAmount: null,
      discountLabel: null,
    });
  });

  it('reports the money saved and the rule or coupon names', () => {
    expect(
      invoiceLineDiscount(
        {
          discounts: {
            lineTotalBefore: 1000,
            applied: [
              { name: 'Loyal customer', code: 'LOYAL', couponCode: '' },
              { name: 'Welcome', code: 'WELCOME', couponCode: 'HELLO10' },
            ],
          },
        },
        '850.00',
      ),
    ).toEqual({ savedAmount: '150.00', discountLabel: 'Loyal customer; Welcome (coupon HELLO10)' });
  });

  it('falls back to the rule code when the name is blank', () => {
    expect(
      invoiceLineDiscount(
        {
          discounts: {
            lineTotalBefore: 500,
            applied: [{ name: '', code: 'VIP5', couponCode: undefined }],
          },
        },
        '475.00',
      ),
    ).toEqual({ savedAmount: '25.00', discountLabel: 'VIP5' });
  });

  it('does not report a saving when the final total is the same as the starting price', () => {
    expect(
      invoiceLineDiscount({ discounts: { lineTotalBefore: 500, applied: [] } }, '500.00'),
    ).toEqual({ savedAmount: null, discountLabel: null });
  });
});
