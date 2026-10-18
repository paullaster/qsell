/**
 * The statement import panel: choosing which column is which, the amount layout, and what the check
 * and import send. Pure. The server checks the file and the mapping again.
 */
import type { LookupPage } from './lookup';

export interface CsvMapping {
  headerRow: number;
  date: string;
  dateFormat?: 'auto' | 'mdy';
  description: string[];
  reference?: string;
  balance?: string;
  amount?: string;
  paidIn?: string;
  withdrawn?: string;
}

export const BLANK_MAPPING: CsvMapping = { headerRow: 1, date: '', dateFormat: 'auto', description: [] };

export const DATE_FORMATS = [
  { id: 'auto', label: 'Day first (13/10/2026) or 2026-10-13' },
  { id: 'mdy', label: 'Month first (10/13/2026)' },
] as const;

export type AmountMode = 'single' | 'split';

/** What the file turned out to be. Only a CSV (or a workbook turned into one) needs columns chosen. */
export type FileFormat = 'csv' | 'mt940' | 'camt053';

export const isFileFormat = (v: string): v is FileFormat => v === 'csv' || v === 'mt940' || v === 'camt053';

/** The mapping to start from: what was saved for the account if it still fits the file, else the suggestion, else blank. */
export function startingMapping(saved: CsvMapping | null, suggested: CsvMapping | null, headers: readonly string[]): CsvMapping {
  if (saved !== null && saved.date !== '' && headers.includes(saved.date)) return saved;
  return suggested ?? BLANK_MAPPING;
}

export const startingAmountMode = (m: CsvMapping): AmountMode => (m.amount === undefined || m.amount === '' ? 'split' : 'single');

/** The mapping as it is sent: no empty description columns, and only the amount columns the layout uses. */
export function cleanMapping(map: CsvMapping, mode: AmountMode): CsvMapping {
  const base = { ...map, description: map.description.filter((d) => d !== '') };
  return mode === 'single' ? { ...base, paidIn: undefined, withdrawn: undefined } : { ...base, amount: undefined };
}

const has = (v: string | undefined): boolean => v !== undefined && v !== '';

/** True when enough columns are chosen to check the file. */
export function mappingReady(format: FileFormat, map: CsvMapping, mode: AmountMode): boolean {
  if (format !== 'csv') return true;
  if (!has(map.date) || map.description.length === 0) return false;
  return mode === 'single' ? has(map.amount) : has(map.paidIn) || has(map.withdrawn);
}

export const withDescription = (map: CsvMapping, index: 0 | 1, value: string): CsvMapping => {
  const next = [...map.description];
  next[index] = value;
  return { ...map, description: next.filter((d) => d !== '') };
};

export const importFields = (format: FileFormat, map: CsvMapping, mode: AmountMode, save: boolean): Record<string, string> => ({
  format,
  mapping: JSON.stringify(cleanMapping(map, mode)),
  headerRow: String(map.headerRow),
  saveFormat: save ? '1' : '0',
});

export function importedMessage(r: { lines: number; duplicates: number; autoMatched: number; proposed: number }): string {
  const lines = `${String(r.lines)} line${r.lines === 1 ? '' : 's'}`;
  const dupes = r.duplicates > 0 ? ` (${String(r.duplicates)} already there)` : '';
  return `Imported ${lines}${dupes}. ${String(r.autoMatched)} matched by themselves, ${String(r.proposed)} suggested.`;
}

const MAX_HEADERS = 200;
const MAX_HEADER_LENGTH = 120;
const MAX_PAGE = 50;

/** One page of a file's column names matching the typed text, in file order. The names come from the browser, so they are capped. */
export function pageHeaders(headers: readonly string[], query: string, cursor: string | null, limit: number): LookupPage {
  const needle = query.trim().toLowerCase().slice(0, 100);
  const clean = headers
    .slice(0, MAX_HEADERS)
    .map((h) => h.slice(0, MAX_HEADER_LENGTH))
    .filter((h, i, all) => h !== '' && all.indexOf(h) === i)
    .filter((h) => needle === '' || h.toLowerCase().includes(needle));
  const start = cursor !== null && /^\d{1,3}$/.test(cursor) ? Number(cursor) : 0;
  const size = Math.max(1, Math.min(limit, MAX_PAGE));
  const slice = clean.slice(start, start + size);
  const next = start + size;
  return { options: slice.map((h) => ({ id: h, label: h, description: null, badge: null })), nextCursor: next < clean.length ? String(next) : null };
}

/** Rows of text that have no id of their own, given stable keys for the list that shows them. */
export function withKeys<T>(items: readonly T[], prefix: string): { key: string; item: T }[] {
  return items.map((item, index) => ({ key: `${prefix}-${String(index)}`, item }));
}

/** A line's description, else its reference, else nothing. */
export const lineLabel = (description: string, reference: string | null): string => (description === '' ? (reference ?? '') : description);
