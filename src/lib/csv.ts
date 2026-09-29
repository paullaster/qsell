/**
 * RFC 4180 CSV reading and writing, shared by browser exports and server imports
 * so both sides agree byte-for-byte on quoting, line breaks and escaping.
 *
 * - Fields may be quoted; quotes inside quoted fields are doubled ("").
 * - Quoted fields may contain commas and line breaks (product descriptions do).
 * - CRLF, LF and lone CR line endings are all accepted on read; writes use CRLF.
 */

export class CsvParseError extends Error {
  constructor(
    message: string,
    /** 1-based physical line where the problem was detected. */
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvParseError';
  }
}

export interface CsvRecord {
  /** 1-based line on which the record starts, as a spreadsheet user would count it. */
  line: number;
  fields: string[];
}

/** Parse CSV text into records. Throws `CsvParseError` on malformed quoting. */
export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let quotedFieldStartLine = 1;
  let atFieldStart = true;

  const endField = () => {
    fields.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRecord = () => {
    endField();
    // A completely empty line is not a record (common at end of file).
    if (!(fields.length === 1 && fields[0] === '')) {
      records.push({ line: recordLine, fields });
    }
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          const next = i + 1 < text.length ? text[i + 1] : ',';
          if (next !== ',' && next !== '\n' && next !== '\r') {
            throw new CsvParseError(
              'Unexpected character after a closing quote. Wrap the whole value in quotes and double any quotes inside it ("").',
              line,
            );
          }
        }
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      quotedFieldStartLine = line;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
      atFieldStart = true;
    } else {
      if (ch === '"') {
        throw new CsvParseError(
          'A quote appears in the middle of an unquoted value. Wrap the value in quotes and double the inner quote ("").',
          line,
        );
      }
      field += ch;
      atFieldStart = false;
    }
  }

  if (inQuotes) {
    throw new CsvParseError('A quoted value is never closed.', quotedFieldStartLine);
  }
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

/**
 * Spreadsheet apps execute cells that start with these characters as formulas,
 * so exported text starting with one is prefixed with an apostrophe
 * ("CSV injection"). `unguardFormula` reverses it on import.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function guardFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

export function unguardFormula(value: string): string {
  return value.startsWith("'") && FORMULA_TRIGGER.test(value.slice(1)) ? value.slice(1) : value;
}

function quoteField(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

/** Serialise rows (header first) to CSV text with CRLF line endings. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.map(quoteField).join(',')).join('\r\n')}\r\n`;
}

/** Byte-order mark: makes Excel open UTF-8 CSV files with accents and emoji intact. */
export const UTF8_BOM = '﻿';
