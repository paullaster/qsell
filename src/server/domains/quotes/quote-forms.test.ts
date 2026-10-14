import { describe, expect, it } from 'vitest';
import { blankQuoteForm, parseTotalsRequest, quoteFormOf, TOTALS_MAX_LINES } from './quote-forms';
import type { SalesQuote } from './service';

const ids = () => {
  let n = 0;
  return () => `new-${String(++n)}`;
};

const saved = {
  customerId: 'c1',
  customerName: 'Acme',
  customerEmail: null,
  customerPhone: '0700',
  billingAddress: { street: '1' },
  deliveryAddress: { street: '2' },
  currency: 'KES',
  paymentMethod: 'mpesa_daraja',
  paymentTerms: null,
  templateId: 't1',
  templateName: 'Pack',
  showBillingAddress: false,
  paymentDetails: null,
  termsAndConditions: null,
  validUntil: new Date('2026-11-13T23:59:59Z'),
  customerReference: null,
  publicNotes: null,
  internalNotes: null,
  quoteDiscountPercent: '5.000',
  shippingFee: '300.00',
  couponCodes: ['SAVE'],
  sections: [
    {
      id: 's-db',
      title: 'Extras',
      description: null,
      showLines: true,
      fromTemplate: false,
      sectionTemplateId: 'st1',
      sectionTemplateName: 'Baking',
    },
  ],
  lines: [
    {
      productId: 'p1',
      sectionId: 's-db',
      quantity: '2.000',
      unitPrice: '99.5000',
      discountPercent: '1.000',
      isGift: false,
      fromTemplate: true,
      fromSectionTemplate: false,
    },
    {
      productId: 'p2',
      sectionId: null,
      quantity: '1.000',
      unitPrice: '0.0000',
      discountPercent: '0.000',
      isGift: true,
      fromTemplate: false,
      fromSectionTemplate: false,
    },
    {
      productId: null,
      sectionId: null,
      quantity: '3.000',
      unitPrice: '10.0000',
      discountPercent: '0.000',
      isGift: false,
      fromTemplate: false,
      fromSectionTemplate: false,
    },
  ],
} as unknown as SalesQuote;

describe('the form for a new quote', () => {
  it('is empty, in shillings, valid for thirty days', () => {
    const form = blankQuoteForm(new Date('2026-10-14T10:00:00Z'));
    expect(form).toMatchObject({
      customerName: '',
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      templateId: null,
      lines: [],
      sections: [],
      validUntil: '2026-11-13',
      discountPercent: 0,
    });
  });
});

describe('the form for editing a saved quote', () => {
  const form = quoteFormOf(saved, ids());

  it('turns amounts into numbers and the date into a day', () => {
    expect(form).toMatchObject({
      customerId: 'c1',
      discountPercent: 5,
      shippingFee: 300,
      validUntil: '2026-11-13',
      couponCodes: ['SAVE'],
      templateName: 'Pack',
    });
  });

  it('gives sections new ids and points their items at them', () => {
    expect(form.sections).toEqual([
      expect.objectContaining({
        id: 'new-1',
        title: 'Extras',
        sectionTemplateId: 'st1',
        sectionTemplateName: 'Baking',
      }),
    ]);
    expect(form.lines[0]?.sectionId).toBe('new-1');
  });

  it('keeps the agreed price, and leaves free gifts out', () => {
    expect(form.lines).toHaveLength(2);
    expect(form.lines[0]).toMatchObject({
      productId: 'p1',
      quantity: 2,
      unitPrice: 99.5,
      priceMode: 'kept',
      discountPercent: 1,
      fromTemplate: true,
    });
    expect(form.lines.some((l) => l.productId === 'p2')).toBe(false);
  });

  it('holds an item whose product was deleted with an empty product id', () => {
    expect(form.lines[1]?.productId).toBe('');
  });

  it('has no valid-until when the quote has none', () => {
    expect(quoteFormOf({ ...saved, validUntil: null } as SalesQuote, ids()).validUntil).toBeNull();
  });
});

describe('checking a totals request from the browser', () => {
  const good = {
    lines: [{ productId: 'p', quantity: 2, discountPercent: 0, unitPrice: 10 }],
    discountPercent: 5,
    shippingFee: 20,
  };

  it('accepts a good one and keeps only the fields it knows', () => {
    const parsed = parseTotalsRequest({
      ...good,
      lines: [{ ...good.lines[0], extra: 'x', isGift: true }],
      companyId: 'x',
    });
    expect(parsed).toEqual({
      ...good,
      lines: [{ productId: 'p', quantity: 2, discountPercent: 0, unitPrice: 10 }],
    });
  });

  it('keeps the section an item sits in, and refuses a bad one', () => {
    const parsed = parseTotalsRequest({
      ...good,
      lines: [{ productId: 'p', quantity: 1, discountPercent: 0, sectionId: 's1' }],
    });
    expect(parsed.lines[0]).toMatchObject({ sectionId: 's1' });
    expect(() =>
      parseTotalsRequest({
        ...good,
        lines: [{ productId: 'p', quantity: 1, discountPercent: 0, sectionId: 5 }],
      }),
    ).toThrow();
    const nulled = parseTotalsRequest({
      ...good,
      lines: [{ productId: 'p', quantity: 1, discountPercent: 0, sectionId: null }],
    });
    expect(nulled.lines[0]).not.toHaveProperty('sectionId');
  });

  it('leaves the price out when none was given', () => {
    const parsed = parseTotalsRequest({
      ...good,
      lines: [{ productId: 'p', quantity: 1, discountPercent: 0 }],
    });
    expect(parsed.lines[0]).not.toHaveProperty('unitPrice');
  });

  it('refuses anything else', () => {
    for (const raw of [
      null,
      'x',
      [],
      { ...good, lines: 'x' },
      { ...good, discountPercent: 101 },
      { ...good, discountPercent: '5' },
      { ...good, shippingFee: -1 },
      { ...good, shippingFee: Number.NaN },
    ]) {
      expect(() => parseTotalsRequest(raw)).toThrow();
    }
    const badLines = [
      null,
      { productId: 5, quantity: 1, discountPercent: 0 },
      { productId: 'p', quantity: -1, discountPercent: 0 },
      { productId: 'p', quantity: 1e9, discountPercent: 0 },
      { productId: 'p', quantity: Number.POSITIVE_INFINITY, discountPercent: 0 },
      { productId: 'p', quantity: 1, discountPercent: 150 },
      { productId: 'p', quantity: 1, discountPercent: 0, unitPrice: -5 },
      { productId: 'p', quantity: 1, discountPercent: 0, unitPrice: '5' },
    ];
    for (const line of badLines)
      expect(() => parseTotalsRequest({ ...good, lines: [line] })).toThrow(/Invalid quote items/);
  });

  it('caps how many items it will work out', () => {
    const line = { productId: 'p', quantity: 1, discountPercent: 0 };
    expect(() =>
      parseTotalsRequest({
        ...good,
        lines: Array.from({ length: TOTALS_MAX_LINES + 1 }, () => line),
      }),
    ).toThrow(/Invalid quote items/);
  });
});
