import { looksLikeCamt } from './bank-statement-camt';
import { XlsxError, looksLikeZip, readXlsxRows, rowsToCsv } from './xlsx-lite';

/**
 * What kind of file a bank statement is, whatever it was called: an Excel workbook (turned into CSV text, so the same columns
 * are chosen), a camt.053 XML statement, an MT940 file or a CSV. Pure: bytes in, text and kind out.
 */
export type StatementFormat = 'csv' | 'mt940' | 'camt053';

export interface StatementFile {
  format: StatementFormat;
  text: string;
  /** Where the text came from, for the person: "an Excel workbook", "a CSV file". */
  from: 'excel' | 'camt053' | 'mt940' | 'csv';
}

export class StatementFileError extends Error {}

export const MAX_STATEMENT_FILE_BYTES = 10 * 1024 * 1024;

export function readStatementFile(bytes: Uint8Array): StatementFile {
  if (bytes.length === 0) throw new StatementFileError('The file is empty.');
  if (bytes.length > MAX_STATEMENT_FILE_BYTES) throw new StatementFileError('That file is larger than 10 MB. Split it by month.');
  if (looksLikeZip(bytes)) {
    try {
      const rows = readXlsxRows(bytes);
      if (rows.length === 0) throw new StatementFileError('The first sheet of this workbook is empty.');
      return { format: 'csv', text: rowsToCsv(rows), from: 'excel' };
    } catch (error) {
      if (error instanceof XlsxError || error instanceof StatementFileError) throw new StatementFileError(error.message);
      throw error;
    }
  }
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  if (looksLikeCamt(text)) return { format: 'camt053', text, from: 'camt053' };
  if (/^\s*:20:|\n:61:/.test(text)) return { format: 'mt940', text, from: 'mt940' };
  return { format: 'csv', text, from: 'csv' };
}

export const FILE_WORDS: Record<StatementFile['from'], string> = {
  excel: 'an Excel workbook (its first sheet)',
  camt053: 'an ISO 20022 (camt.053) statement',
  mt940: 'an MT940 statement',
  csv: 'a CSV file',
};
