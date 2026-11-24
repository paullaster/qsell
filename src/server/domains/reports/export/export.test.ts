import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/csv';
import { readXlsxRows } from '@/server/domains/finance/domain/xlsx-lite';
import { buildCsv } from './csv';
import { safeText, stripControls } from './sanitize';
import { cellText, factLines, tableProblems, type ExportFacts, type ExportTable } from './table';
import { buildXlsx, columnName } from './xlsx';
import { zipFiles } from './zip';

const FACTS: ExportFacts = {
  companyName: 'Acme Traders Ltd',
  reportTitle: 'Receivables ageing',
  question: 'Who owes us money, how much, and how late is it?',
  asOf: '2026-03-10T18:00:00.000Z',
  scope: 'All branches',
  definitionsVersion: '2026-11-v1',
};

const TABLE: ExportTable = {
  title: 'Receivables ageing',
  columns: [
    { label: 'Customer', kind: 'text' },
    { label: 'Owed', kind: 'money' },
    { label: 'Invoices', kind: 'count' },
    { label: 'Share', kind: 'percent' },
  ],
  rows: [
    ['Wanjiku & Sons', 12345.5, 4, 61.25],
    ['Otieno <Hardware>', 7000, 2, 38.75],
    ['No contact', null, 0, 0],
  ],
  totals: ['Total', 19345.5, 6, 100],
};

describe('table helpers', () => {
  it('draws numbers as text by kind', () => {
    expect(cellText(1234.5, 'money')).toBe('1234.50');
    expect(cellText(3.6, 'count')).toBe('4');
    expect(cellText(61.25, 'percent')).toBe('61.3');
    expect(cellText(null, 'money')).toBe('');
    expect(cellText('text', 'money')).toBe('text');
  });

  it('lists the facts in a fixed order and skips an empty scope', () => {
    expect(factLines(FACTS).map(([l]) => l)).toEqual([
      'Company',
      'Report',
      'Question answered',
      'Figures as of',
      'Scope',
      'Definitions version',
    ]);
    expect(factLines({ ...FACTS, scope: '' }).map(([l]) => l)).not.toContain('Scope');
  });

  it('finds a table that is not safe to write', () => {
    expect(tableProblems(TABLE)).toEqual([]);
    expect(tableProblems({ ...TABLE, columns: [] }).join()).toMatch(/no columns/);
    expect(tableProblems({ ...TABLE, rows: [['a', 1]] }).join()).toMatch(/row 1 has 2 cells/);
    expect(tableProblems({ ...TABLE, rows: [['a', Number.NaN, 1, 1]] }).join()).toMatch(
      /not finite/,
    );
    expect(tableProblems({ ...TABLE, totals: ['x'] }).join()).toMatch(/totals row/);
  });
});

describe('sanitising text', () => {
  it('prefixes text that a spreadsheet would run as a formula', () => {
    for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '=HYPERLINK("http://evil")']) {
      expect(safeText(bad), bad).toBe(`'${bad}`);
    }
    expect(safeText('Normal name')).toBe('Normal name');
    expect(safeText("O'Brien")).toBe("O'Brien");
    expect(safeText('')).toBe('');
  });

  it('removes characters no file can carry but keeps ordinary line breaks and tabs inside text', () => {
    expect(stripControls('a\u0000b\u0007c\u001Fd\u007Fe')).toBe('abcde');
    expect(stripControls('line1\nline2\tx')).toBe('line1\nline2\tx');
  });

  it('guards after cleaning, so a hidden control cannot smuggle a formula past the guard', () => {
    expect(safeText('\u0000=1+1')).toBe("'=1+1");
  });
});

describe('CSV export', () => {
  const text = buildCsv(TABLE, FACTS);

  it('starts with a byte-order mark and uses CRLF line ends', () => {
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('\r\n');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('writes labels, rows, totals and the facts', () => {
    const rows = parseCsv(text.slice(1)).map((r) => r.fields);
    expect(rows[0]).toEqual(['Customer', 'Owed', 'Invoices', 'Share']);
    expect(rows[1]).toEqual(['Wanjiku & Sons', '12345.50', '4', '61.3']);
    expect(rows[3]).toEqual(['No contact', '', '0', '0.0']);
    expect(rows[4]).toEqual(['Total', '19345.50', '6', '100.0']);
    const facts = rows.filter((r) => r[0] === 'Company' || r[0] === 'Definitions version');
    expect(facts).toEqual([
      ['Company', 'Acme Traders Ltd'],
      ['Definitions version', '2026-11-v1'],
    ]);
  });

  it('quotes fields with commas, quotes and line breaks', () => {
    const t: ExportTable = { ...TABLE, rows: [['Smith, "Bob"\nJr', 1, 1, 1]], totals: undefined };
    const rows = parseCsv(buildCsv(t, FACTS).slice(1)).map((r) => r.fields);
    expect(rows[1]?.[0]).toBe('Smith, "Bob"\nJr');
  });

  it('neutralises formulas in names and in labels', () => {
    const t: ExportTable = {
      title: 'x',
      columns: [{ label: '=EVIL()', kind: 'text' }],
      rows: [["=cmd|' /C calc'!A0"], ['+1'], ['-1+1'], ['@SUM(1)']],
    };
    const rows = parseCsv(buildCsv(t, FACTS).slice(1)).map((r) => r.fields);
    expect(rows[0]?.[0]).toBe("'=EVIL()");
    expect(rows[1]?.[0]?.startsWith("'=")).toBe(true);
    expect(rows[2]?.[0]).toBe("'+1");
    expect(rows[3]?.[0]).toBe("'-1+1");
    expect(rows[4]?.[0]).toBe("'@SUM(1)");
  });

  it('writes a negative number plainly, not as a guarded text', () => {
    const t: ExportTable = {
      title: 'x',
      columns: [{ label: 'Variance', kind: 'money' }],
      rows: [[-250.5]],
    };
    const rows = parseCsv(buildCsv(t, FACTS).slice(1)).map((r) => r.fields);
    expect(rows[1]?.[0]).toBe('-250.50');
  });
});

describe('spreadsheet export', () => {
  const bytes = buildXlsx(TABLE, FACTS);

  it('is a zip file', () => {
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  it('reads back through the platform spreadsheet reader with the same cells', () => {
    const rows = readXlsxRows(bytes);
    expect(rows[0]).toEqual(['Customer', 'Owed', 'Invoices', 'Share']);
    expect(rows[1]).toEqual(['Wanjiku & Sons', '12345.5', '4', '61.25']);
    expect(rows[2]).toEqual(['Otieno <Hardware>', '7000', '2', '38.75']);
    expect(rows[3]).toEqual(['No contact', '', '0', '0']);
    expect(rows[4]).toEqual(['Total', '19345.5', '6', '100']);
  });

  it('keeps numbers as numbers so a spreadsheet can add them', () => {
    const text = new TextDecoder().decode(zipEntry(bytes, 'xl/worksheets/sheet1.xml'));
    expect(text).toContain('<v>12345.5</v>');
    expect(text).not.toContain('t="inlineStr"><is><t xml:space="preserve">12345.5');
  });

  it('freezes the header row and gives the columns widths', () => {
    const text = new TextDecoder().decode(zipEntry(bytes, 'xl/worksheets/sheet1.xml'));
    expect(text).toContain('state="frozen"');
    expect(text).toContain('<cols>');
  });

  it('neutralises formulas and removes characters XML cannot carry', () => {
    const t: ExportTable = {
      title: 'x',
      columns: [{ label: 'Name', kind: 'text' }],
      rows: [['=1+1'], ['bad\u0000char\u0008here'], ['<script>&"'], ['@x']],
    };
    const rows = readXlsxRows(buildXlsx(t, FACTS));
    expect(rows[1]?.[0]).toBe("'=1+1");
    expect(rows[2]?.[0]).toBe('badcharhere');
    expect(rows[3]?.[0]).toBe('<script>&"');
    expect(rows[4]?.[0]).toBe("'@x");
  });

  it('writes the facts to a second sheet', () => {
    const text = new TextDecoder().decode(zipEntry(bytes, 'xl/worksheets/sheet2.xml'));
    for (const [label, value] of factLines(FACTS)) {
      expect(text).toContain(label.replace(/&/g, '&amp;'));
      expect(text).toContain(value.replace(/&/g, '&amp;'));
    }
  });

  it('names columns the way a spreadsheet does', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });

  it('handles an empty table and a wide one', () => {
    const empty = readXlsxRows(buildXlsx({ ...TABLE, rows: [], totals: undefined }, FACTS));
    expect(empty).toEqual([['Customer', 'Owed', 'Invoices', 'Share']]);
    const wide: ExportTable = {
      title: 'w',
      columns: Array.from({ length: 30 }, (_, i) => ({
        label: `C${String(i)}`,
        kind: 'count' as const,
      })),
      rows: [Array.from({ length: 30 }, (_, i) => i)],
    };
    const rows = readXlsxRows(buildXlsx(wide, FACTS));
    expect(rows[1]?.[29]).toBe('29');
  });
});

describe('zip writer', () => {
  it('writes a file that can be read back', () => {
    const z = zipFiles({ 'a.txt': 'hello', 'dir/b.txt': 'world'.repeat(1000) });
    expect(new TextDecoder().decode(zipEntry(z, 'a.txt'))).toBe('hello');
    expect(new TextDecoder().decode(zipEntry(z, 'dir/b.txt'))).toBe('world'.repeat(1000));
  });
});

/** Read one stored or deflated entry from a zip, for the tests only. */
import { inflateRawSync } from 'node:zlib';
function zipEntry(zip: Buffer, name: string): Buffer {
  let eocd = zip.length - 22;
  while (zip.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    const entryName = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (entryName === name) {
      const localName = zip.readUInt16LE(offset + 26);
      const localExtra = zip.readUInt16LE(offset + 28);
      const start = offset + 30 + localName + localExtra;
      const data = zip.subarray(start, start + compressed);
      return method === 8 ? inflateRawSync(data) : data;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`no entry ${name}`);
}
