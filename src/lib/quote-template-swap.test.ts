import { describe, expect, it } from 'vitest';
import type { QuoteInput } from '@/server/domains/quotes/service';
import { planTemplateSwap, type SwapTemplate } from './quote-template-swap';

let n = 0;
const newId = () => `new-${++n}`;
const price = () => 100;

const template = (
  id: string,
  over: Partial<SwapTemplate> = {},
  lines: SwapTemplate['lines'] = [],
  sections: SwapTemplate['sections'] = [],
): SwapTemplate => ({
  id,
  name: `Template ${id}`,
  currency: 'KES',
  paymentMethod: 'mpesa_daraja',
  paymentTerms: null,
  paymentDetails: null,
  termsAndConditions: null,
  showBillingAddress: false,
  publicNotes: null,
  internalNotes: null,
  quoteDiscountPercent: '0',
  shippingFee: '0',
  sections,
  lines,
  ...over,
});
const tl = (productId: string, quantity = '1', sectionId: string | null = null) => ({
  productId,
  sectionId,
  quantity,
  priceMode: 'catalog',
  unitPrice: null,
  discountPercent: '0',
});

const A = template(
  'A',
  { termsAndConditions: 'Terms A', shippingFee: '500' },
  [tl('rice', '5'), tl('beans', '2', 'sa')],
  [{ id: 'sa', title: 'Staples', description: null, showLines: false }],
);
const B = template(
  'B',
  { termsAndConditions: 'Terms B', shippingFee: '900', paymentTerms: 'Net 7' },
  [tl('flour', '10'), tl('oil', '1', 'sb')],
  [{ id: 'sb', title: 'Staples', description: null, showLines: false }],
);

const quote = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  customerId: 'c1',
  customerName: 'Acme',
  currency: 'KES',
  paymentMethod: 'mpesa_daraja',
  templateId: 'A',
  termsAndConditions: 'Terms A',
  shippingFee: 500,
  discountPercent: 0,
  customerReference: 'PO-1',
  billingAddress: { street: 'Main' },
  sections: [{ id: 's1', title: 'Staples', fromTemplate: true }],
  lines: [
    { productId: 'rice', quantity: 5, discountPercent: 0, fromTemplate: true },
    { productId: 'beans', quantity: 2, discountPercent: 0, sectionId: 's1', fromTemplate: true },
  ],
  ...over,
});
const products = (q: QuoteInput) => q.lines.map((l) => l.productId);

describe('switching a quote built from a template', () => {
  it('replaces everything that came from the old template and nothing is asked', () => {
    const plan = planTemplateSwap(quote(), A, B, price, newId);
    expect(plan.kind).toBe('replace');
    expect(plan.edited).toEqual([]);
    const next = plan.apply(false);
    expect(products(next)).toEqual(['flour', 'oil']);
    expect(next.templateId).toBe('B');
    expect(next.sections).toHaveLength(1);
    expect(next.lines.every((l) => l.fromTemplate)).toBe(true);
    expect(next.lines[1]!.sectionId).toBe(next.sections[0]!.id);
  });

  it('keeps the customer, addresses and reference', () => {
    const next = planTemplateSwap(quote(), A, B, price, newId).apply(false);
    expect(next).toMatchObject({
      customerId: 'c1',
      customerName: 'Acme',
      customerReference: 'PO-1',
      billingAddress: { street: 'Main' },
    });
  });

  it('only overwrites header values the person left as the old template had them', () => {
    const next = planTemplateSwap(
      quote({ termsAndConditions: 'My own terms' }),
      A,
      B,
      price,
      newId,
    ).apply(false);
    expect(next.termsAndConditions).toBe('My own terms');
    expect(next.shippingFee).toBe(900);
    expect(next.paymentTerms).toBe('Net 7');
  });

  it('asks about additions, and keeps or drops them as told', () => {
    const q = quote({
      lines: [
        ...quote().lines,
        { productId: 'salt', quantity: 3, discountPercent: 0 },
        { productId: 'tea', quantity: 1, discountPercent: 0, sectionId: 's2' },
      ],
      sections: [...quote().sections!, { id: 's2', title: 'Extras' }],
    });
    const plan = planTemplateSwap(q, A, B, price, newId);
    expect(plan.kind).toBe('additions');
    expect(plan.additions.lines.map((l) => l.productId)).toEqual(['salt', 'tea']);
    expect(plan.additions.sections.map((s) => s.id)).toEqual(['s2']);
    const kept = plan.apply(true);
    expect(products(kept)).toEqual(['flour', 'oil', 'salt', 'tea']);
    expect(kept.sections.map((s) => s.title)).toEqual(['Staples', 'Extras']);
    expect(kept.lines[3]!.sectionId).toBe('s2');
    expect(kept.lines[2]!.fromTemplate).toBeUndefined();
    expect(products(plan.apply(false))).toEqual(['flour', 'oil']);
  });

  it('moves a kept item out of a replaced section into the new one of the same name', () => {
    const q = quote({
      lines: [
        ...quote().lines,
        { productId: 'salt', quantity: 1, discountPercent: 0, sectionId: 's1' },
      ],
    });
    const next = planTemplateSwap(q, A, B, price, newId).apply(true);
    const salt = next.lines.find((l) => l.productId === 'salt')!;
    expect(salt.sectionId).toBe(next.sections.find((s) => s.title === 'Staples')!.id);
  });

  it('lists template items the person changed, which are replaced all the same', () => {
    const q = quote({
      lines: [
        { productId: 'rice', quantity: 8, discountPercent: 0, fromTemplate: true },
        quote().lines[1]!,
      ],
    });
    const plan = planTemplateSwap(q, A, B, price, newId);
    expect(plan.kind).toBe('replace');
    expect(plan.edited.map((l) => l.productId)).toEqual(['rice']);
    expect(products(plan.apply(false))).toEqual(['flour', 'oil']);
  });

  it('removing the template drops its items and leaves the header alone', () => {
    const next = planTemplateSwap(quote(), A, null, price, newId).apply(false);
    expect(next.templateId).toBeNull();
    expect(next.lines).toEqual([]);
    expect(next.shippingFee).toBe(500);
  });
});

describe('choosing a template for a quote that had none', () => {
  it('warns that the template replaces what the quote holds', () => {
    const q = quote({
      templateId: null,
      termsAndConditions: 'Mine',
      lines: [{ productId: 'salt', quantity: 1, discountPercent: 0 }],
      sections: [],
    });
    const plan = planTemplateSwap(q, null, B, price, newId);
    expect(plan.kind).toBe('manual');
    expect(plan.replacedLines).toBe(1);
    const next = plan.apply(true);
    expect(products(next)).toEqual(['flour', 'oil']);
    expect(next.termsAndConditions).toBe('Terms B');
    expect(next.customerName).toBe('Acme');
  });

  it('applies straight away when the quote is empty', () => {
    const q = quote({ templateId: null, lines: [], sections: [] });
    expect(planTemplateSwap(q, null, B, price, newId).kind).toBe('none');
  });
});
