import { createHash } from 'node:crypto';

import { has } from '@/lib/has';
import { emptyToNull, orElse, trimToNull } from '@/lib/values';

/** Reading bank statements and suggesting matches. No database; money is in whole cents. */

export interface ParsedLine {
  lineNo: number;
  date: string;
  description: string;
  reference: string | null;
  counterparty: string | null;
  /** Positive = money in. */
  amountCents: number;
  balanceCents: number | null;
}

export interface ParsedStatement {
  lines: ParsedLine[];
  /** Rows left out and why (blank rows, totals, headings). */
  skipped: { row: number; reason: string }[];
  /** Rows that look like money but could not be read: the import is refused while there are any. */
  errors: { row: number; message: string }[];
  openingCents: number | null;
  closingCents: number | null;
  /** Rows where the running balance does not follow from the one before. */
  balanceBreaks: number[];
  headers: string[];
}

export interface CsvMapping {
  /** 1-based row holding the column names. */
  headerRow: number;
  date: string;
  dateFormat?: 'auto' | 'dmy' | 'mdy' | 'ymd';
  description: string[];
  reference?: string;
  counterparty?: string;
  /** One signed column... */
  amount?: string;
  /** ...or money-in and money-out columns. */
  paidIn?: string;
  withdrawn?: string;
  balance?: string;
}

/** Safaricom's M-Pesa statement export. */
export const MPESA_MAPPING: CsvMapping = {
  headerRow: 1,
  date: 'Completion Time',
  dateFormat: 'auto',
  description: ['Details'],
  reference: 'Receipt No.',
  paidIn: 'Paid In',
  withdrawn: 'Withdrawn',
  balance: 'Balance',
};

// ── CSV ──────────────────────────────────────────────────────────────────────

export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Rows of cells; quotes, doubled quotes and line breaks inside quotes are honoured. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A date in the ways banks write it. Returns YYYY-MM-DD or null. Day-first unless told otherwise. */
export function parseDate(raw: string, format: 'auto' | 'dmy' | 'mdy' | 'ymd' = 'auto'): string | null {
  const s = raw.trim();
  if (!has(s)) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ,]+(\d{2,4})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo === null || mo === undefined || mo === 0) return null;
    const y = +m[3];
    return iso(y < 100 ? 2000 + y : y, mo, +m[1]);
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y0 = +m[3];
    const y = y0 < 100 ? 2000 + y0 : y0;
    if (format === 'mdy') return iso(y, a, b);
    return iso(y, b, a);
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return null;
}

/** "1,234.50", "(120.00)", "KES 5,000", "300.00 DR", "-45" -> cents. null when it is not a number. */
export function parseMoney(raw: string): number | null {
  let s = raw.trim();
  if (!has(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bDR\b\.?$/i.test(s)) {
    negative = !negative;
    s = s.replace(/\s*DR\.?$/i, '');
  } else if (/\bCR\b\.?$/i.test(s)) s = s.replace(/\s*CR\.?$/i, '');
  s = s.replace(/^[A-Za-z]{3}\.?\s*/, '').replace(/[A-Za-z]{3}$/, '').replace(/\s/g, '');
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (s.includes(',')) {
    // A single comma followed by exactly 1-2 digits is a decimal comma; otherwise thousands.
    s = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const [w = '0', f = ''] = s.split('.');
  if (/[1-9]/.test(f.slice(2))) return null;
  const cents = Number(orElse(w, '0')) * 100 + Number((`${f  }00`).slice(0, 2));
  return negative ? -cents : cents;
}

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

export function lineHash(l: { date: string; amountCents: number; reference: string | null; description: string }, occurrence: number): string {
  const text = [l.date, String(l.amountCents), (l.reference ?? '').trim().toUpperCase(), l.description.trim().replace(/\s+/g, ' ').toUpperCase(), String(occurrence)].join('|');
  return createHash('sha256').update(text).digest('hex');
}

/** Counts how many times the same line has appeared so far, so identical real lines stay distinct. */
export function withHashes<T extends { date: string; amountCents: number; reference: string | null; description: string }>(lines: T[]): (T & { lineHash: string })[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const key = lineHash(l, 0);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { ...l, lineHash: lineHash(l, n) };
  });
}

function finish(lines: ParsedLine[], skipped: ParsedStatement['skipped'], errors: ParsedStatement['errors'], headers: string[]): ParsedStatement {
  let ordered = lines;
  // Newest-first files are put in the order things happened.
  if (ordered.length > 1 && ordered[0].date > ordered[ordered.length - 1].date) ordered = [...ordered].reverse();
  ordered = ordered.map((l, i) => ({ ...l, lineNo: i + 1 }));
  const breaks: number[] = [];
  const allBal = ordered.length > 0 && ordered.every((l) => l.balanceCents !== null);
  if (allBal) {
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i - 1].balanceCents! + ordered[i].amountCents !== ordered[i].balanceCents!) breaks.push(ordered[i].lineNo);
    }
  }
  return {
    lines: ordered,
    skipped,
    errors,
    openingCents: allBal ? ordered[0].balanceCents! - ordered[0].amountCents : null,
    closingCents: allBal ? ordered[ordered.length - 1].balanceCents! : null,
    balanceBreaks: breaks,
    headers,
  };
}

export function readHeaders(text: string, headerRow = 1): { headers: string[]; sample: string[][] } {
  const rows = parseCsv(text);
  const headers = (rows[headerRow - 1] ?? []).map((h) => h.trim());
  return { headers, sample: rows.slice(headerRow, headerRow + 5) };
}

/** Reads a CSV statement with the chosen columns. Problems are reported, never guessed around. */
export function parseCsvStatement(text: string, m: CsvMapping): ParsedStatement {
  const rows = parseCsv(text);
  const headerCells = (rows[m.headerRow - 1] ?? []).map((h) => h.trim());
  const idx = new Map(headerCells.map((h, i) => [norm(h), i] as const));
  const errors: ParsedStatement['errors'] = [];
  const col = (name: string | undefined, label: string, required = false): number | null => {
    if (!has(name)) {
      if (required) errors.push({ row: m.headerRow, message: `Choose the ${label} column.` });
      return null;
    }
    const i = idx.get(norm(name));
    if (i === undefined) {
      errors.push({ row: m.headerRow, message: `The ${label} column "${name}" is not in the file.` });
      return null;
    }
    return i;
  };
  const cDate = col(m.date, 'date', true);
  const cDesc = m.description.map((d) => col(d, 'description')).filter((x): x is number => x !== null);
  const cRef = col(m.reference, 'reference');
  const cCp = col(m.counterparty, 'counterparty');
  const cAmt = col(m.amount, 'amount');
  const cIn = col(m.paidIn, 'money-in');
  const cOut = col(m.withdrawn, 'money-out');
  const cBal = col(m.balance, 'balance');
  if (!has(m.amount) && !has(m.paidIn) && !has(m.withdrawn)) errors.push({ row: m.headerRow, message: 'Choose the amount column, or the money-in and money-out columns.' });
  if (errors.length > 0) return finish([], [], errors, headerCells);

  const lines: ParsedLine[] = [];
  const skipped: ParsedStatement['skipped'] = [];
  for (let r = m.headerRow; r < rows.length; r++) {
    const cells = rows[r];
    const n = r + 1;
    if (cells.every((c) => c.trim() === '')) continue;
    const get = (i: number | null) => (i === null ? '' : (cells[i] ?? '').trim());
    let cents: number | null = null;
    let bad = false;
    if (cAmt !== null) {
      const v = get(cAmt);
      cents = parseMoney(v);
      if (v !== '' && cents === null) bad = true;
    } else {
      const vi = get(cIn);
      const vo = get(cOut);
      const a = vi === '' ? 0 : parseMoney(vi);
      const b = vo === '' ? 0 : parseMoney(vo);
      if (a === null || b === null) bad = true;
      else if (vi !== '' || vo !== '') cents = Math.abs(a) - Math.abs(b);
    }
    const date = parseDate(get(cDate), m.dateFormat ?? 'auto');
    if (bad) {
      errors.push({ row: n, message: `Row ${n}: the amount "${get(cAmt ?? cIn ?? cOut)}" could not be read.` });
      continue;
    }
    if (cents === null || cents === 0) {
      skipped.push({ row: n, reason: 'no amount' });
      continue;
    }
    if (!has(date) && get(cDate) === '' && /total|balance|brought|carried|b\/f|c\/f|summary/i.test(cDesc.map((i) => get(i)).join(' '))) {
      skipped.push({ row: n, reason: 'a total or carried-forward row' });
      continue;
    }
    if (!has(date)) {
      errors.push({ row: n, message: `Row ${n}: the date "${get(cDate)}" could not be read, and the row has money in it.` });
      continue;
    }
    const balRaw = get(cBal);
    lines.push({
      lineNo: 0,
      date,
      description: cDesc.map((i) => get(i)).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      reference: emptyToNull(get(cRef)),
      counterparty: emptyToNull(get(cCp)),
      amountCents: cents,
      balanceCents: balRaw === '' ? null : parseMoney(balRaw),
    });
  }
  if (lines.length === 0 && errors.length === 0) errors.push({ row: m.headerRow, message: 'No transactions were found in the file.' });
  return finish(lines, skipped, errors, headerCells);
}

// ── MT940 ────────────────────────────────────────────────────────────────────

function mtDate(yymmdd: string): string | null {
  const y = 2000 + Number(yymmdd.slice(0, 2));
  return iso(y, Number(yymmdd.slice(2, 4)), Number(yymmdd.slice(4, 6)));
}
const mtAmount = (s: string) => parseMoney(s.replace(',', '.'));

export function parseMt940(text: string): ParsedStatement {
  const lines: ParsedLine[] = [];
  const errors: ParsedStatement['errors'] = [];
  let opening: number | null = null;
  let closing: number | null = null;
  const blocks = text.replace(/\r/g, '').split(/\n(?=:\d{2}[A-Z]?:)/);
  let current: ParsedLine | null = null;
  blocks.forEach((b, i) => {
    const m = /^:(\d{2}[A-Z]?):([\s\S]*)$/.exec(b.trim());
    if (!m) return;
    const tag = m[1];
    const body = m[2];
    if (tag === '60F' || tag === '60M') {
      const o = /^([CD])(\d{6})[A-Z]{3}([\d,]+)/.exec(body);
      if (o) opening = (o[1] === 'D' ? -1 : 1) * (mtAmount(o[3]) ?? 0);
    } else if (tag === '62F' || tag === '62M') {
      const o = /^([CD])(\d{6})[A-Z]{3}([\d,]+)/.exec(body);
      if (o) closing = (o[1] === 'D' ? -1 : 1) * (mtAmount(o[3]) ?? 0);
    } else if (tag === '61') {
      const first = body.split('\n')[0];
      const o = /^(\d{6})(\d{4})?(R?[CD])[A-Z]?([\d,]+)N([A-Z0-9]{3})([^/]*)(?:\/\/(.*))?/.exec(first);
      const date = o ? mtDate(o[1]) : null;
      const cents = o ? mtAmount(o[4]) : null;
      if (!o || !has(date) || cents === null) {
        errors.push({ row: i + 1, message: `Statement line ${i + 1} could not be read: ${first.slice(0, 60)}` });
        current = null;
        return;
      }
      const sign = o[3].endsWith('D') ? -1 : 1;
      current = { lineNo: 0, date, description: '', reference: trimToNull((o[7] ?? o[6] ?? '')), counterparty: null, amountCents: sign * cents * (o[3].startsWith('R') ? -1 : 1), balanceCents: null };
      lines.push(current);
    } else if (tag === '86' && current) {
      current.description = body.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      current = null;
    }
  });
  if (lines.length === 0 && errors.length === 0) errors.push({ row: 1, message: 'No transactions were found in the file.' });
  const res = finish(lines, [], errors, []);
  return { ...res, openingCents: opening, closingCents: closing };
}

// ── Matching ─────────────────────────────────────────────────────────────────

export interface LineForMatch {
  id: number;
  date: string;
  amountCents: number;
  description: string;
  reference: string | null;
}
export interface EntryForMatch {
  id: number;
  date: string;
  amountCents: number;
  /** Words the bank might quote back: document number, the payer's reference, the payout reference. */
  refs: string[];
}
export interface Suggestion {
  lineId: number;
  entryIds: number[];
  /** `reference` = the bank quoted the document's own reference; `amount_date` = same amount, close in time. */
  rule: 'reference' | 'amount_date';
  /** matched: safe to apply by itself. proposed: a person confirms. */
  certainty: 'matched' | 'proposed';
}

export const normRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

/**
 * For each line, the ledger entry it most likely closes. Same amount is always required.
 * 1. The line quotes the document's reference and exactly one entry fits: matched.
 * 2. Otherwise same amount within `windowDays`: proposed (all candidates, nearest first).
 * An entry is used by at most one certain match.
 */
export function suggestMatches(lines: LineForMatch[], entries: EntryForMatch[], opts: { windowDays?: number; maxProposals?: number } = {}): Suggestion[] {
  const windowDays = opts.windowDays ?? 3;
  const maxProposals = opts.maxProposals ?? 5;
  const byAmount = new Map<number, EntryForMatch[]>();
  for (const e of entries) byAmount.set(e.amountCents, [...(byAmount.get(e.amountCents) ?? []), e]);
  const used = new Set<number>();
  const out: Suggestion[] = [];
  const ordered = [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const line of ordered) {
    const pool = (byAmount.get(line.amountCents) ?? []).filter((e) => !used.has(e.id));
    if (pool.length === 0) continue;
    const hay = normRef(`${line.reference ?? ''} ${line.description}`);
    const hits = pool.filter((e) => e.refs.some((r) => normRef(r).length >= 5 && hay.includes(normRef(r))));
    if (hits.length === 1) {
      used.add(hits[0].id);
      out.push({ lineId: line.id, entryIds: [hits[0].id], rule: 'reference', certainty: 'matched' });
      continue;
    }
    const near = (hits.length > 1 ? hits : pool)
      .filter((e) => daysBetween(e.date, line.date) <= windowDays)
      .sort((a, b) => daysBetween(a.date, line.date) - daysBetween(b.date, line.date) || a.id - b.id)
      .slice(0, maxProposals);
    if (near.length > 0) out.push({ lineId: line.id, entryIds: near.map((e) => e.id), rule: hits.length > 1 ? 'reference' : 'amount_date', certainty: 'proposed' });
  }
  return out;
}

/** The reconciliation sum: opening + the lines being closed should equal what the bank says. */
export function reconciliationDifference(openingCents: number, lineAmounts: number[], statementCents: number) {
  const total = lineAmounts.reduce((n, a) => n + a, 0);
  return { total, expected: openingCents + total, difference: statementCents - (openingCents + total) };
}

/** Cents from a stored amount ("1500.0000") or typed text ("1500.5"). More than two real decimals is refused. */
export function centsOf(value: string): number {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!m) throw new Error(`"${value}" is not an amount.`);
  const frac = m[3] ?? '';
  if (/[1-9]/.test(frac.slice(2))) throw new Error(`"${value}" has more than 2 decimal places.`);
  const cents = Number(m[2]) * 100 + Number((`${frac  }00`).slice(0, 2));
  return has(m[1]) ? -cents : cents;
}
