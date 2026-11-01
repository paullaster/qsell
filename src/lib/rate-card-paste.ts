/**
 * Reads a rate card pasted from a spreadsheet or typed as lines: one fee to a line, the columns split by a tab (what a
 * spreadsheet copies), a semicolon or a comma. Pure; the zone codes are matched to zones by the server afterwards.
 *
 *   by zone:  zone, from kg, up to kg, fee, each extra kg
 *   flat:     from kg, up to kg, fee, each extra kg
 *
 * A zone of "*", "any" or nothing is the fee for any other zone. An empty "up to kg" (or "-", "no limit", "max") has no upper limit.
 * A first line of column names is skipped.
 */

export const MAX_PASTED_FEES = 1000;

export interface PastedFee {
  /** The row's place in the pasted text, from 1, for telling a person where a problem is. */
  line: number;
  /** Upper case; null for "any other zone" and for a flat card. */
  zoneCode: string | null;
  fromKg: string;
  toKg: string;
  fee: string;
  perExtraKg: string;
}

export interface PasteProblem {
  line: number;
  text: string;
  message: string;
}

export interface PastedRateCard {
  fees: PastedFee[];
  problems: PasteProblem[];
  /** True when there were more lines than `MAX_PASTED_FEES`; the rest were not read. */
  truncated: boolean;
  /** The distinct zone codes the fees refer to. */
  zoneCodes: string[];
}

const NO_LIMIT = new Set(['', '-', '–', '—', '∞', 'no limit', 'nolimit', 'max', 'none', 'unlimited']);
const ANY_ZONE = new Set(['', '*', 'any', 'all', 'other', 'default']);

function splitLine(line: string): { cells: string[]; commasAreThousands: boolean } {
  if (line.includes('\t')) return { cells: line.split('\t'), commasAreThousands: true };
  if (line.includes(';')) return { cells: line.split(';'), commasAreThousands: false };
  return { cells: line.split(','), commasAreThousands: false };
}

function numberText(cell: string, commasAreThousands: boolean): string {
  const noCurrency = cell.trim().replace(/^(kes|ksh|ksh\.|kshs|ugx|usd)\s*/i, '');
  return (commasAreThousands ? noCurrency.replace(/,/g, '') : noCurrency).replace(/\s+/g, '');
}

const KG = /^\d{1,7}(\.\d{1,3})?$/;
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

function isHeader(cells: readonly string[], commasAreThousands: boolean): boolean {
  const looksNumeric = (c: string) => /^\d/.test(numberText(c, commasAreThousands));
  return !cells.some(looksNumeric);
}

export function parseRateCardPaste(text: string, byZone: boolean): PastedRateCard {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fees: PastedFee[] = [];
  const problems: PasteProblem[] = [];
  const zones = new Set<string>();
  let truncated = false;
  let sawFirst = false;

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === '') return;
    if (fees.length + problems.length >= MAX_PASTED_FEES) {
      truncated = true;
      return;
    }
    const { cells, commasAreThousands } = splitLine(raw);
    if (!sawFirst) {
      sawFirst = true;
      if (isHeader(cells, commasAreThousands)) return;
    }
    const need = byZone ? 4 : 3;
    if (cells.length < need) {
      problems.push({ line, text: raw.trim(), message: `Needs ${byZone ? 'zone, from kg, up to kg and fee' : 'from kg, up to kg and fee'}, separated by a tab, a semicolon or a comma.` });
      return;
    }
    if (cells.length > need + 1) {
      problems.push({ line, text: raw.trim(), message: 'Has more columns than a fee has.' });
      return;
    }
    const zoneCell = byZone ? (cells[0] ?? '').trim() : '';
    const rest = (byZone ? cells.slice(1) : cells).map((c) => numberText(c, commasAreThousands));
    const [fromKg = '', toRaw = '', fee = '', perExtraKg = ''] = rest;
    const toKg = NO_LIMIT.has(toRaw.toLowerCase()) ? '' : toRaw;
    const mistakes: string[] = [];
    if (!KG.test(fromKg)) mistakes.push('"From kg" must be a weight such as 0 or 2.5');
    if (toKg !== '' && !KG.test(toKg)) mistakes.push('"Up to kg" must be a weight, or empty for no limit');
    if (KG.test(fromKg) && toKg !== '' && KG.test(toKg) && Number(toKg) <= Number(fromKg)) mistakes.push('"Up to kg" must be more than "from kg"');
    if (!MONEY.test(fee)) mistakes.push('"Fee" must be an amount such as 350 or 350.50');
    if (perExtraKg !== '' && !MONEY.test(perExtraKg)) mistakes.push('"Each extra kg" must be an amount, or empty');
    if (byZone && !ANY_ZONE.has(zoneCell.toLowerCase()) && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(zoneCell)) mistakes.push('The zone must be a zone code');
    if (mistakes.length > 0) {
      problems.push({ line, text: raw.trim(), message: `${mistakes.join('; ')}.` });
      return;
    }
    const zoneCode = byZone && !ANY_ZONE.has(zoneCell.toLowerCase()) ? zoneCell.toUpperCase() : null;
    if (zoneCode !== null) zones.add(zoneCode);
    fees.push({ line, zoneCode, fromKg, toKg, fee, perExtraKg });
  });

  return { fees, problems, truncated, zoneCodes: [...zones].sort() };
}
