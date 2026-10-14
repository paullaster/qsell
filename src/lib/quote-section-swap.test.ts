import { describe, expect, it } from 'vitest';
import type { QuoteInput } from '@/server/domains/quotes/service';
import {
  addSectionFromTemplate,
  planSectionSwap,
  type SectionSwapTemplate,
} from './quote-section-swap';
import { planTemplateSwap, type SwapTemplate } from './quote-template-swap';

const price = () => 100;
const tpl = (
  id: string,
  title: string,
  products: [string, string?][],
  over: Partial<SectionSwapTemplate> = {},
): SectionSwapTemplate => ({
  id,
  name: `Section ${id}`,
  sectionTitle: title,
  sectionDescription: null,
  showLines: false,
  lines: products.map(([productId, quantity = '1']) => ({
    productId,
    quantity,
    priceMode: 'catalog',
    unitPrice: null,
    discountPercent: '0',
  })),
  ...over,
});
const A = tpl('A', 'Roofing', [['sheet', '10'], ['nail']]);
const B = tpl('B', 'Walling', [['block', '50']]);

const quote = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  customerName: 'Acme',
  currency: 'KES',
  paymentMethod: 'mpesa_daraja',
  discountPercent: 0,
  shippingFee: 0,
  sections: [],
  lines: [],
  ...over,
});
const products = (q: QuoteInput, sectionId?: string) =>
  q.lines
    .filter((l) => sectionId === undefined || l.sectionId === sectionId)
    .map((l) => l.productId);

describe('adding a section from a section template', () => {
  it('adds a section with its items, marked as coming from the template', () => {
    const q = addSectionFromTemplate(
      quote({ lines: [{ productId: 'x', quantity: 1, discountPercent: 0 }] }),
      A,
      price,
      () => 's1',
    );
    expect(q.sections).toEqual([
      expect.objectContaining({
        id: 's1',
        title: 'Roofing',
        sectionTemplateId: 'A',
        fromTemplate: false,
      }),
    ]);
    expect(products(q, 's1')).toEqual(['sheet', 'nail']);
    expect(
      q.lines.filter((l) => l.sectionId === 's1').every((l) => l.fromSectionTemplate === true),
    ).toBe(true);
    expect(q.lines[0]).toMatchObject({ productId: 'x' });
  });
});

describe('switching the template of a section', () => {
  const built = () => addSectionFromTemplate(quote(), A, price, () => 's1');

  it('replaces the items and takes the new title when it was not edited', () => {
    const plan = planSectionSwap(built(), 's1', A, B, price);
    expect(plan.kind).toBe('replace');
    const next = plan.apply(false);
    expect(products(next, 's1')).toEqual(['block']);
    expect(next.sections[0]).toMatchObject({ id: 's1', title: 'Walling', sectionTemplateId: 'B' });
  });

  it('keeps a title the person changed', () => {
    const q = built();
    q.sections[0].title = 'My roof';
    const next = planSectionSwap(q, 's1', A, B, price).apply(false);
    expect(next.sections[0].title).toBe('My roof');
  });

  it('asks about items added by hand inside the section, and leaves other sections alone', () => {
    const q = built();
    q.lines.push({ productId: 'bolt', quantity: 4, discountPercent: 0, sectionId: 's1' });
    q.lines.push({ productId: 'loose', quantity: 1, discountPercent: 0 });
    const plan = planSectionSwap(q, 's1', A, B, price);
    expect(plan.kind).toBe('additions');
    expect(plan.additions.lines.map((l) => l.productId)).toEqual(['bolt']);
    expect(products(plan.apply(true), 's1').sort()).toEqual(['block', 'bolt']);
    expect(products(plan.apply(false), 's1')).toEqual(['block']);
    expect(products(plan.apply(true))).toContain('loose');
  });

  it('lists items changed since the template', () => {
    const q = built();
    q.lines[0].quantity = 99;
    const plan = planSectionSwap(q, 's1', A, B, price);
    expect(plan.edited.map((l) => l.productId)).toEqual(['sheet']);
  });

  it('warns when the section was made by hand, and replaces what it holds', () => {
    const q = quote({
      sections: [{ id: 's1', title: 'Mine', fromTemplate: true }],
      lines: [
        { productId: 'x', quantity: 1, discountPercent: 0, sectionId: 's1', fromTemplate: true },
      ],
    });
    const plan = planSectionSwap(q, 's1', null, B, price);
    expect(plan.kind).toBe('manual');
    const next = plan.apply(true);
    expect(products(next, 's1')).toEqual(['block']);
    expect(next.sections[0]).toMatchObject({ title: 'Walling', fromTemplate: false });
  });

  it('removing the template drops its items and keeps the section', () => {
    const next = planSectionSwap(built(), 's1', A, null, price).apply(false);
    expect(next.sections[0]).toMatchObject({ title: 'Roofing', sectionTemplateId: null });
    expect(products(next, 's1')).toEqual([]);
  });
});

describe('a quote-level template switch leaves section-template sections as additions', () => {
  it('keeps them when asked', () => {
    const qt = {
      id: 'QA',
      name: 'QA',
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
      sections: [],
      lines: [],
    } as SwapTemplate;
    const q = addSectionFromTemplate({ ...quote(), templateId: 'QA' }, A, price, () => 's1');
    const plan = planTemplateSwap(q, qt, null, price);
    expect(plan.kind).toBe('additions');
    expect(plan.additions.sections.map((s) => s.id)).toEqual(['s1']);
    const next = plan.apply(true);
    expect(next.sections[0]).toMatchObject({ sectionTemplateId: 'A' });
    expect(products(next, 's1')).toEqual(['sheet', 'nail']);
  });
});
