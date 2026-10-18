import { describe, expect, it } from 'vitest';
import { XlsxError, columnIndex, looksLikeZip, readXlsxRows, rowsToCsv } from './xlsx-lite';
import { workbook, zip } from './xlsx-test-kit';

const sheet = `
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
  <row r="2"><c r="A2"><v>46308</v></c><c r="B2" t="inlineStr"><is><t>Paid by Jane &amp; Co</t></is></c><c r="C2"><v>1500.4999999999998</v></c></row>
  <row r="4"><c r="A4" t="str"><v>2026-10-17</v></c><c r="C4"><v>-45</v></c></row>`;

describe('reading an Excel statement', () => {
  const book = zip(workbook(sheet, ['Date', 'Details', 'Amount']));

  it('gives the first sheet as rows: shared and inline text, numbers without float noise, gaps filled in', () => {
    expect(readXlsxRows(book)).toEqual([
      ['Date', 'Details', 'Amount'],
      ['46308', 'Paid by Jane & Co', '1500.5'],
      ['', '', ''],
      ['2026-10-17', '', '-45'],
    ]);
  });

  it('works whether the parts are deflated or stored', () => {
    expect(readXlsxRows(zip(workbook(sheet, ['Date', 'Details', 'Amount']), { method: 0 }))[1][1]).toBe('Paid by Jane & Co');
  });

  it('turns rows into CSV text with quoting, and reads column letters', () => {
    expect(rowsToCsv([['a', 'b,c'], ['"q"', 'line\nbreak']])).toBe('a,"b,c"\r\n"""q""","line\nbreak"\r\n');
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('Z')).toBe(25);
    expect(columnIndex('ab')).toBe(27);
  });

  it('recognises a zip by its first bytes', () => {
    expect(looksLikeZip(book)).toBe(true);
    expect(looksLikeZip(Buffer.from('Date,Amount'))).toBe(false);
  });

  it('refuses what is not a workbook, is encrypted, lies about its size, or carries a document type', () => {
    expect(() => readXlsxRows(Buffer.from('Date,Amount\n1,2'))).toThrow(/not a zip/);
    expect(() => readXlsxRows(zip({ 'a.txt': 'x' }))).toThrow(/does not look like an Excel/);
    expect(() => readXlsxRows(zip(workbook(sheet, ['a']), { encrypted: true }))).toThrow(/password/);
    expect(() => readXlsxRows(zip(workbook(sheet, ['a']), { lieAboutSize: 10 }))).toThrow(XlsxError);
    expect(() => readXlsxRows(zip({ ...workbook(sheet), 'xl/sharedStrings.xml': '<!DOCTYPE s [<!ENTITY x "boom">]><sst/>' }))).toThrow(/document type/);
  });
});
