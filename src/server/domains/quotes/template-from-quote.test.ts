import { describe, expect, it } from 'vitest';
import { templateDraftFromQuote, type QuoteForTemplate } from './template-from-quote';

const quote = (over: Partial<QuoteForTemplate> = {}): QuoteForTemplate => ({
  quoteNumber: 'QTE-2026-0000000007',
  customerId: 'cust-1',
  customerName: 'Acme Ltd',
  currency: 'KES',
  paymentMethod: 'mpesa_daraja',
  paymentTerms: '50% deposit',
  paymentDetails: 'Paybill 123',
  termsAndConditions: 'Terms',
  showBillingAddress: true,
  validUntil: new Date('2026-11-07T23:59:59Z'),
  createdAt: new Date('2026-10-08T10:00:00Z'),
  quoteDiscountPercent: '5.000',
  shippingFee: '250.00',
  publicNotes: 'Thanks',
  internalNotes: 'Margin is thin',
  billingAddress: { street: '1 Rd', city: 'Nairobi' },
  deliveryAddress: { street: '2 Rd', city: 'Mombasa' },
  sections: [
    { id: 'S1', title: 'Hardware', description: 'All kit', showLines: true },
    { id: 'S2', title: 'Services', description: null, showLines: false },
  ],
  lines: [
    {
      sectionId: 'S1',
      productId: 'p1',
      description: 'Panel',
      quantity: '2.000',
      unitPrice: '500',
      discountPercent: '10',
      isGift: false,
      priceTrace: { source: 'standard' },
    },
    {
      sectionId: null,
      productId: 'p2',
      description: 'Cable',
      quantity: '5',
      unitPrice: '20',
      discountPercent: '0',
      isGift: false,
      priceTrace: null,
    },
    {
      sectionId: 'S1',
      productId: 'p3',
      description: 'Inverter',
      quantity: '1',
      unitPrice: '800',
      discountPercent: '0',
      isGift: false,
      priceTrace: { source: 'price_list' },
    },
    {
      sectionId: null,
      productId: 'p9',
      description: 'Free pen',
      quantity: '1',
      unitPrice: '0',
      discountPercent: '0',
      isGift: true,
      priceTrace: null,
    },
  ],
  ...over,
});
let n = 0;
const ids = () => `new-${(n += 1)}`;

describe('a template made from a quote', () => {
  it('keeps the arrangement, quantities, discounts, terms, notes and what prints expanded', () => {
    const { input } = templateDraftFromQuote(quote(), { newId: ids });
    expect(input.sections.map((s) => [s.title, s.description, s.showLines])).toEqual([
      ['Hardware', 'All kit', true],
      ['Services', null, false],
    ]);
    expect(input.lines.map((l) => [l.productId, l.quantity, l.discountPercent])).toEqual([
      ['p1', 2, 10],
      ['p2', 5, 0],
      ['p3', 1, 0],
    ]);
    // Lines stay in the section they were in, under the section's new id.
    const hardware = input.sections[0]!.id;
    expect(input.lines.filter((l) => l.sectionId === hardware).map((l) => l.productId)).toEqual([
      'p1',
      'p3',
    ]);
    expect(input.lines[1]!.sectionId).toBeNull();
    expect(input).toMatchObject({
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      paymentTerms: '50% deposit',
      termsAndConditions: 'Terms',
      quoteDiscountPercent: 5,
      shippingFee: 250,
      publicNotes: 'Thanks',
      internalNotes: 'Margin is thin',
      isDefault: false,
    });
  });

  it('gives the sections new ids, never the quote’s', () => {
    const { input } = templateDraftFromQuote(quote(), { newId: ids });
    expect(input.sections.map((s) => s.id)).not.toContain('S1');
    expect(new Set(input.sections.map((s) => s.id)).size).toBe(2);
  });

  it('keeps catalog-priced lines on the catalog and typed prices as fixed prices', () => {
    const { input } = templateDraftFromQuote(quote());
    expect(input.lines[0]).toMatchObject({ priceMode: 'catalog', unitPrice: null });
    expect(input.lines[1]).toMatchObject({ priceMode: 'fixed', unitPrice: 20 });
    expect(input.lines[2]).toMatchObject({ priceMode: 'catalog', unitPrice: null });
  });

  it("treats a price whose explanation says 'none' as typed, as saved quotes record it", () => {
    const q = quote();
    q.lines[0]!.priceTrace = { source: 'none' };
    expect(templateDraftFromQuote(q).input.lines[0]).toMatchObject({
      priceMode: 'fixed',
      unitPrice: 500,
    });
  });

  it('leaves out the customer and addresses unless asked, and takes them when asked', () => {
    const plain = templateDraftFromQuote(quote()).input;
    expect(plain).toMatchObject({
      customerId: null,
      billingAddress: {},
      deliveryAddress: {},
      showBillingAddress: false,
    });
    expect(plain.description).toBe('Made from quote QTE-2026-0000000007.');
    const kept = templateDraftFromQuote(quote(), { keepCustomer: true }).input;
    expect(kept).toMatchObject({ customerId: 'cust-1', showBillingAddress: true });
    expect(kept.billingAddress).toEqual({ street: '1 Rd', city: 'Nairobi' });
    expect(kept.description).toContain('Acme Ltd');
  });

  it('does not copy free gifts, and says how many there were', () => {
    const d = templateDraftFromQuote(quote());
    expect(d.gifts).toBe(1);
    expect(d.input.lines.map((l) => l.productId)).not.toContain('p9');
  });

  it('leaves out items that cannot be sold or no longer exist, and says which and why', () => {
    const q = quote();
    q.lines.push({
      sectionId: null,
      productId: null,
      description: 'Gone item',
      quantity: '1',
      unitPrice: '1',
      discountPercent: '0',
      isGift: false,
      priceTrace: null,
    });
    const d = templateDraftFromQuote(q, { canSell: (id) => id !== 'p2' });
    expect(d.input.lines.map((l) => l.productId)).toEqual(['p1', 'p3']);
    expect(d.skipped).toEqual([
      { name: 'Cable', reason: 'The product can no longer be sold.' },
      { name: 'Gone item', reason: 'The product no longer exists.' },
    ]);
  });

  it('works out the validity from the quote, within the limits the template allows', () => {
    expect(templateDraftFromQuote(quote()).input.validityDays).toBe(30);
    expect(templateDraftFromQuote(quote({ validUntil: null })).input.validityDays).toBe(30);
    expect(
      templateDraftFromQuote(quote({ validUntil: new Date('2026-10-08T10:00:00Z') })).input
        .validityDays,
    ).toBe(1);
    expect(
      templateDraftFromQuote(quote({ validUntil: new Date('2099-01-01') })).input.validityDays,
    ).toBe(3650);
  });

  it('suggests a name that no template has', () => {
    expect(templateDraftFromQuote(quote()).input.name).toBe('QTE-2026-0000000007 template');
    const taken = new Set(['qte-2026-0000000007 template', 'qte-2026-0000000007 template (2)']);
    expect(templateDraftFromQuote(quote(), { takenNames: taken }).input.name).toBe(
      'QTE-2026-0000000007 template (3)',
    );
  });

  it('keeps an empty section, and handles a quote with no sections', () => {
    const empty = templateDraftFromQuote(quote({ lines: [] })).input;
    expect(empty.sections).toHaveLength(2);
    expect(empty.lines).toEqual([]);
    expect(templateDraftFromQuote(quote({ sections: [], lines: [] })).input.sections).toEqual([]);
  });
});
