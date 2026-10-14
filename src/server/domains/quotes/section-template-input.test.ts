import { describe, expect, it } from 'vitest';
import { parseSectionTemplateInput, SECTION_TEMPLATE_LIMITS } from './section-template-input';

const line = { productId: 'p1', quantity: 2, priceMode: 'catalog', discountPercent: 0 };
const valid = { name: 'Baking set', sectionTitle: 'Baking', showLines: true, lines: [line] };
const rejects = (raw: unknown, message: RegExp) => {
  expect(() => parseSectionTemplateInput(raw)).toThrow(message);
};

describe('checking a section template that came from the browser', () => {
  it('accepts a good one and cleans it', () => {
    const parsed = parseSectionTemplateInput({
      ...valid,
      name: '  Baking set  ',
      category: '   ',
      description: ' Flour things ',
      sectionDescription: undefined,
      lines: [line, { ...line, productId: 'p2', priceMode: 'fixed', unitPrice: 12.5 }],
    });
    expect(parsed).toMatchObject({
      name: 'Baking set',
      category: null,
      description: 'Flour things',
      sectionDescription: null,
      showLines: true,
    });
    expect(parsed.lines[0]).toEqual({ ...line, unitPrice: null });
    expect(parsed.lines[1]).toMatchObject({ priceMode: 'fixed', unitPrice: 12.5 });
  });

  it('titles the section with the name when no title is given', () => {
    expect(parseSectionTemplateInput({ ...valid, sectionTitle: '  ' }).sectionTitle).toBe(
      'Baking set',
    );
  });

  it('rejects what is not an object, and a missing name or items', () => {
    for (const raw of [null, undefined, 'x', 5, [], [valid]])
      rejects(raw, /Invalid section template/);
    rejects({ ...valid, name: undefined }, /name is required/);
    rejects({ ...valid, name: '   ' }, /name is required/);
    rejects({ ...valid, name: 5 }, /not valid/);
    rejects({ ...valid, lines: [] }, /at least one product/);
    rejects({ ...valid, lines: 'x' }, /at least one product/);
  });

  it('limits how long and how big things may be', () => {
    rejects({ ...valid, name: 'x'.repeat(SECTION_TEMPLATE_LIMITS.name + 1) }, /limited to 120/);
    rejects({ ...valid, description: 'x'.repeat(501) }, /limited to 500/);
    const many = Array.from({ length: SECTION_TEMPLATE_LIMITS.lines + 1 }, () => line);
    rejects({ ...valid, lines: many }, /limited to 500 items/);
  });

  it('checks every item', () => {
    rejects({ ...valid, lines: [null] }, /Item 1 is not valid/);
    rejects({ ...valid, lines: [{ ...line, productId: '' }] }, /Item 1 product is required/);
    rejects({ ...valid, lines: [{ ...line, priceMode: 'free' }] }, /price source/);
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2', null, 1e7]) {
      rejects({ ...valid, lines: [{ ...line, quantity }] }, /quantity/);
    }
    for (const discountPercent of [-1, 101, '5', undefined]) {
      rejects({ ...valid, lines: [{ ...line, discountPercent }] }, /discount/);
    }
    rejects({ ...valid, lines: [{ ...line, priceMode: 'fixed' }] }, /fixed price/);
    rejects({ ...valid, lines: [{ ...line, priceMode: 'fixed', unitPrice: -5 }] }, /fixed price/);
  });

  it('ignores a price on a catalogue-priced item rather than trusting it', () => {
    const parsed = parseSectionTemplateInput({ ...valid, lines: [{ ...line, unitPrice: 999 }] });
    expect(parsed.lines[0]?.unitPrice).toBeNull();
  });

  it('only accepts a real yes or no for keep-expanded', () => {
    rejects({ ...valid, showLines: 'yes' }, /yes or no/);
    expect(parseSectionTemplateInput({ ...valid, showLines: undefined }).showLines).toBe(false);
  });
});
