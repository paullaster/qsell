import { inflateRawSync } from 'node:zlib';

/**
 * Reads the first sheet of an Excel (.xlsx) file as rows of text, so a bank statement saved from Excel can go through the same
 * column-choosing as a CSV. An .xlsx is a zip of XML parts; this reads only the parts it needs, refuses encrypted, zip64 and
 * oversized files, and never expands more than it was told to expect. Pure: bytes in, rows out.
 */
export class XlsxError extends Error {}

const MAX_ENTRIES = 2000;
const MAX_PART_BYTES = 60 * 1024 * 1024;
const MAX_ROWS = 200_000;
const MAX_COLUMNS = 200;

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  flags: number;
}

function entriesOf(zip: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('This is not an Excel file: it is not a zip archive.');
  const count = zip.readUInt16LE(eocd + 10);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new XlsxError('This Excel file uses a zip format that is not supported. Save it again as .xlsx or as CSV.');
  if (count > MAX_ENTRIES) throw new XlsxError('This Excel file has far more parts than a workbook has.');
  const out = new Map<string, ZipEntry>();
  let p = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('This Excel file is damaged.');
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength);
    out.set(name, { name, method, compressed, size, offset, flags });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function read(zip: Buffer, e: ZipEntry): string {
  if ((e.flags & 1) !== 0) throw new XlsxError('This Excel file is password protected. Save a copy without a password.');
  if (e.size > MAX_PART_BYTES) throw new XlsxError('A part of this Excel file is too large to read. Split the statement by month.');
  if (e.offset + 30 > zip.length || zip.readUInt32LE(e.offset) !== 0x04034b50) throw new XlsxError('This Excel file is damaged.');
  const start = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
  const data = zip.subarray(start, start + e.compressed);
  if (data.length !== e.compressed) throw new XlsxError('This Excel file is damaged.');
  let raw: Buffer;
  if (e.method === 0) raw = data;
  else if (e.method === 8) {
    try {
      // Never more than the part says it holds: a file that lies about its size cannot swell in memory.
      raw = inflateRawSync(data, { maxOutputLength: e.size + 1 });
    } catch {
      throw new XlsxError('This Excel file is damaged, or larger inside than it says.');
    }
  } else throw new XlsxError('This Excel file is compressed in a way that is not supported.');
  if (raw.length !== e.size) throw new XlsxError('This Excel file is damaged.');
  const text = raw.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new XlsxError('This Excel file declares a document type or entities, which a workbook never needs. It was not read.');
  return text;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return Object.hasOwn(NAMED, body) ? NAMED[body] : whole;
  });

const textsIn = (xml: string): string => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decode(m[1])).join('');

function sharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  return [...xml.matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textsIn(m[1]));
}

/** Column letters to a zero-based index: A=0, Z=25, AA=26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A number cell as text without the float noise Excel stores (0.30000000000000004 is 0.3). */
function numberText(raw: string): string {
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : raw;
}

function firstSheetPath(files: Map<string, ZipEntry>, zip: Buffer): string {
  const book = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (book === undefined || rels === undefined) throw new XlsxError('This does not look like an Excel workbook.');
  const first = /<(?:\w+:)?sheet\b([^>]*)\/?>/.exec(read(zip, book));
  const rid = first === null ? null : /\b(?:\w+:)?id="([^"]+)"/.exec(first[1].replace(/\bsheetId="[^"]*"/, ''));
  if (rid === null) throw new XlsxError('This workbook has no sheets.');
  for (const m of read(zip, rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1]);
    const target = /\bTarget="([^"]+)"/.exec(m[1]);
    const to = target?.[1];
    if (id?.[1] === rid[1] && to !== undefined) return to.startsWith('/') ? to.slice(1) : `xl/${to}`;
  }
  throw new XlsxError('This workbook\'s first sheet could not be found.');
}

/** The first sheet as rows of cells, shortest rows padded to the widest. */
export function readXlsxRows(bytes: Uint8Array): string[][] {
  const zip = Buffer.from(bytes);
  const files = entriesOf(zip);
  const path = firstSheetPath(files, zip);
  const sheet = files.get(path);
  if (sheet === undefined) throw new XlsxError('This workbook\'s first sheet could not be found.');
  const sharedEntry = files.get('xl/sharedStrings.xml');
  const strings = sharedStrings(sharedEntry === undefined ? undefined : read(zip, sharedEntry));
  const xml = read(zip, sheet);
  const rows: string[][] = [];
  let width = 0;
  let rowNumber = 0;
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const given = /\br="(\d+)"/.exec(rowMatch[1]);
    rowNumber = given === null ? rowNumber + 1 : Number(given[1]);
    if (rowNumber > MAX_ROWS) throw new XlsxError('This sheet has more than 200,000 rows. Split the statement by month.');
    const cells: string[] = [];
    for (const cell of (rowMatch[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = /\br="([A-Za-z]+)\d+"/.exec(cell[1]);
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1] ?? 'n';
      const col = ref === null ? cells.length : columnIndex(ref[1]);
      if (col >= MAX_COLUMNS) continue;
      const body = cell[2] ?? '';
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let value: string;
      if (type === 's') value = v === undefined ? '' : (strings[Number(v)] ?? '');
      else if (type === 'inlineStr') value = textsIn(body);
      else if (type === 'str' || type === 'd') value = v === undefined ? '' : decode(v);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') value = '';
      else value = v === undefined ? '' : numberText(decode(v));
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
    width = Math.max(width, cells.length);
  }
  while (rows.length > 0 && (rows.at(-1) ?? []).every((c) => c === '')) rows.pop();
  return rows.map((r) => [...r, ...Array.from({ length: width - r.length }, () => '')]);
}

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Rows as CSV text, ready for the statement reader. */
export const rowsToCsv = (rows: readonly (readonly string[])[]): string => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

/** True for bytes that start like a zip archive (an .xlsx, an .xlsm, any Office file). */
export const looksLikeZip = (bytes: Uint8Array): boolean => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
