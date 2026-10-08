import type { InvoiceLineItem } from '@/server/ports/communications';

interface LineLike {
  sectionId: string | null;
  sku: string;
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  lineAmount: string | number;
}

interface SectionLike {
  id: string;
  title: string;
  description: string | null;
  /** Print the section's items under its title; otherwise only the title and its total. */
  showLines: boolean;
}

const num = (v: string | number) => Number(v);
const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const asItem = (line: LineLike) => ({
  sku: line.sku,
  name: line.description,
  quantity: num(line.quantity),
  unitPrice: num(line.unitPrice),
  totalPrice: num(line.lineAmount),
});

/**
 * What the customer's copy of a quote lists: the individual items first, then each section. A
 * section prints as its title with its total; when it is set to show its items, they are listed
 * under it too, in the order they were arranged.
 */
export function quotePdfItems(quote: {
  lines: LineLike[];
  sections: SectionLike[];
}): InvoiceLineItem[] {
  return [
    ...quote.lines
      .filter((line) => !line.sectionId)
      .map((line) => ({ kind: 'item' as const, ...asItem(line) })),
    ...quote.sections.map((section) => {
      const lines = quote.lines.filter((line) => line.sectionId === section.id);
      const total = money(lines.reduce((sum, line) => sum + num(line.lineAmount), 0));
      return {
        kind: 'section' as const,
        sectionTotal: total,
        sectionDescription: section.description,
        sku: '',
        name: section.title,
        quantity: 0,
        unitPrice: 0,
        totalPrice: total,
        ...(section.showLines ? { sectionLines: lines.map(asItem) } : {}),
      };
    }),
  ];
}
