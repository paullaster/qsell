import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

type PdfTextMethod = (this: unknown, text: unknown, ...args: unknown[]) => unknown;

/** The text a PDF was asked to draw, in order. */
async function drawn(table: ExportTable, facts: ExportFacts): Promise<string[]> {
  const out: string[] = [];
  const real = Object.getOwnPropertyDescriptor(PDFDocument.prototype, 'text')?.value as PdfTextMethod;
  vi.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (
    this: unknown,
    text: string,
    ...rest: unknown[]
  ) {
    out.push(text);
    return real.call(this, text, ...rest) as never;
  } as never);
  await buildPdf(table, facts);
  return out;
}

describe('what the PDF prints', () => {
  afterEach(() => vi.restoreAllMocks());

  const stock: ExportTable = {
    title: 'Stock valuation',
    columns: [
      { label: 'Product', kind: 'text' },
      { label: 'On hand', kind: 'count' },
      { label: 'Stock value (KES)', kind: 'money' },
      { label: 'Share of value', kind: 'percent' },
    ],
    rows: [
      [
        '10kW Solar Package with 10kW Solis Smart Hybrid Inverter and 16.08kWh Dyness Lithium Battery - Inclusive of Delivery & free installation',
        4,
        2352287.52,
        19.3,
      ],
    ],
    totals: ['Total', 732, 12185595.94, 100],
  };

  it('groups thousands, shows percentages as percentages and keeps the long name whole', async () => {
    const text = await drawn(stock, FACTS);
    expect(text).toContain('2,352,287.52');
    expect(text).toContain('12,185,595.94');
    expect(text).toContain('19.3%');
    expect(text).toContain('100.0%');
    expect(text.some((t) => t.includes('free installation'))).toBe(true);
  });

  it('says what it covers and when it was printed, and never the internal version', async () => {
    const text = await drawn(stock, {
      ...FACTS,
      period: 'As at 25 Nov 2026, 04:13',
      printedAt: '25 Nov 2026, 04:15',
    });
    expect(text).toContain('As at 25 Nov 2026, 04:13   ·   All branches');
    expect(text.some((t) => t.includes('Printed 25 Nov 2026, 04:15'))).toBe(true);
    expect(text.some((t) => t.includes('Definitions version'))).toBe(false);
    expect(text.some((t) => t.includes('2026-11-v1'))).toBe(false);
    expect(text.some((t) => /T\d\d:\d\d:\d\d/.test(t))).toBe(false);
  });

  it('is headed by the company name alone until a heading is chosen', async () => {
    const text = await drawn(stock, FACTS);
    expect(text.slice(0, 2)).toEqual(['Acme Traders Ltd', 'Receivables ageing']);
  });

  it('prints the chosen parts of the business heading before the report name', async () => {
    const text = await drawn(stock, {
      ...FACTS,
      brand: {
        name: 'Acme Traders',
        legalName: 'Acme Traders Ltd',
        tagline: null,
        address: 'Mombasa Road, Nairobi',
        contacts: ['Tel 0712 345 678', 'info@acme.example'],
        kraPin: null,
        logoPath: null,
      },
    });
    const name = text.indexOf('Acme Traders Ltd');
    expect(text.indexOf('Mombasa Road, Nairobi')).toBeGreaterThan(name);
    expect(text).toContain('Tel 0712 345 678   ·   info@acme.example');
    expect(text.indexOf('Receivables ageing')).toBeGreaterThan(text.indexOf('Mombasa Road, Nairobi'));
  });
});
