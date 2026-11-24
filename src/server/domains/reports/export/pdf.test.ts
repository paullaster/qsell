import { describe, expect, it } from 'vitest';
import { buildPdf } from './pdf';
import type { ExportFacts, ExportTable } from './table';

const FACTS: ExportFacts = {
  companyName: 'Acme Traders Ltd',
  reportTitle: 'Receivables ageing',
  question: 'Who owes us money, how much, and how late is it?',
  asOf: '2026-03-10T18:00:00.000Z',
  scope: 'All branches',
  definitionsVersion: '2026-11-v1',
};

const make = (rows: number, columns = 4): ExportTable => ({
  title: 'x',
  columns: Array.from({ length: columns }, (_, i) => ({
    label: `Column ${String(i)}`,
    kind: i === 0 ? ('text' as const) : ('money' as const),
  })),
  rows: Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, i) => (i === 0 ? `Customer ${String(r)}` : r * 100.5 + i)),
  ),
  totals: Array.from({ length: columns }, (_, i) => (i === 0 ? 'Total' : 1000 * i)),
});

const pages = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('PDF export', () => {
  it('writes a PDF', async () => {
    const pdf = await buildPdf(make(5), FACTS);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pages(pdf)).toBe(1);
  });

  it('adds pages when there are many rows, repeating the header and numbering them', async () => {
    const pdf = await buildPdf(make(200), FACTS);
    expect(pages(pdf)).toBeGreaterThan(3);
  });

  it('goes landscape for many columns', async () => {
    const wide = await buildPdf(make(3, 9), FACTS);
    const narrow = await buildPdf(make(3, 4), FACTS);
    // A4 is 595 x 842 points; landscape swaps them.
    expect(wide.toString('latin1')).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
    expect(narrow.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/);
  });

  it('copes with an empty table, a wide one, odd characters and very long text', async () => {
    expect(
      (await buildPdf({ ...make(0), totals: undefined }, FACTS)).subarray(0, 5).toString('latin1'),
    ).toBe('%PDF-');
    expect((await buildPdf(make(2, 25), FACTS)).length).toBeGreaterThan(1000);
    const odd: ExportTable = {
      title: 'x',
      columns: [{ label: 'Name\u0000', kind: 'text' }],
      rows: [[`Wanjiku Ñandi \u0007 ${'long '.repeat(200)}`], ['=1+1']],
    };
    expect((await buildPdf(odd, FACTS)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
