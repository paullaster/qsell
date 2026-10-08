import { describe, expect, it } from 'vitest';
import { quotePdfItems } from './pdf-items';

const line = (sku: string, sectionId: string | null, amount: number, qty = 1) => ({
  sectionId,
  sku,
  description: `Item ${sku}`,
  quantity: String(qty),
  unitPrice: String(amount / qty),
  lineAmount: String(amount),
});
const section = (id: string, showLines: boolean) => ({
  id,
  title: `Section ${id}`,
  description: null,
  showLines,
});

describe('what a quote prints', () => {
  const lines = [
    line('a1', 'A', 100),
    line('i1', null, 50),
    line('a2', 'A', 200, 2),
    line('b1', 'B', 30),
  ];

  it('lists individual items first, then each section as its title with its total', () => {
    const items = quotePdfItems({ lines, sections: [section('A', false), section('B', false)] });
    expect(items.map((i) => [i.kind, i.name])).toEqual([
      ['item', 'Item i1'],
      ['section', 'Section A'],
      ['section', 'Section B'],
    ]);
    expect(items[1]).toMatchObject({ sectionTotal: 300, totalPrice: 300 });
    expect(items[1]!.sectionLines).toBeUndefined();
  });

  it("lists a section's items under it, in order, when it is set to show them", () => {
    const items = quotePdfItems({ lines, sections: [section('A', true), section('B', false)] });
    const a = items[1]!;
    expect(a.sectionLines?.map((l) => [l.sku, l.quantity, l.unitPrice, l.totalPrice])).toEqual([
      ['a1', 1, 100, 100],
      ['a2', 2, 100, 200],
    ]);
    expect(a.sectionTotal).toBe(300);
    // The other section stays collapsed.
    expect(items[2]!.sectionLines).toBeUndefined();
  });

  it('follows the order the lines were arranged in', () => {
    const arranged = [lines[2]!, lines[0]!, lines[1]!, lines[3]!];
    const a = quotePdfItems({ lines: arranged, sections: [section('A', true)] })[1]!;
    expect(a.sectionLines?.map((l) => l.sku)).toEqual(['a2', 'a1']);
  });

  it('an empty section prints its title with a zero total', () => {
    const items = quotePdfItems({ lines: [], sections: [section('Z', true)] });
    expect(items[0]).toMatchObject({ sectionTotal: 0, sectionLines: [] });
  });

  it('adds totals to the cent', () => {
    const l = [line('x', 'A', 0.1), line('y', 'A', 0.2)];
    expect(quotePdfItems({ lines: l, sections: [section('A', false)] })[0]!.sectionTotal).toBe(0.3);
  });
});
