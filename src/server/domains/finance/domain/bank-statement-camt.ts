import { finish, parseDate, parseMoney, type ParsedLine, type ParsedStatement } from './bank-statement';
import { XmlError, child, findAll, parseXml, textAt, type XmlNode } from './xml-lite';

import { emptyToNull, firstFilled, has, orElse } from '@/lib/values';

/**
 * ISO 20022 bank-to-customer statements (camt.053, any version): the booked entries of every statement in the file, their
 * references, the other party and the remittance text, with the bank's own opening and closing balances. Pure.
 */
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A date or date-time element: <Dt> or <DtTm> inside the given parent. */
function dateOf(node: XmlNode | undefined): string | null {
  if (node === undefined) return null;
  const raw = textAt(node, 'Dt') !== '' ? textAt(node, 'Dt') : textAt(node, 'DtTm');
  return raw === '' ? null : parseDate(raw.slice(0, 10));
}

function signedCents(amount: XmlNode | undefined, indicator: string, reversal: boolean): number | null {
  if (amount === undefined) return null;
  const cents = parseMoney(amount.text);
  if (cents === null) return null;
  const credit = indicator.toUpperCase().startsWith('CRDT');
  return (credit ? 1 : -1) * Math.abs(cents) * (reversal ? -1 : 1);
}

const entryStatus = (entry: XmlNode): string => {
  const sts = child(entry, 'Sts');
  if (sts === undefined) return 'BOOK';
  const code = textAt(sts, 'Cd');
  return (code !== '' ? code : sts.text.trim()).toUpperCase();
};

/** The other party of a transaction: the debtor when money came in, the creditor when it went out. */
function counterparty(tx: XmlNode, credit: boolean): string | null {
  const parties = child(tx, 'RltdPties');
  if (parties === undefined) return null;
  const side = credit ? 'Dbtr' : 'Cdtr';
  const name = firstFilled(textAt(parties, side, 'Nm'), textAt(parties, side, 'Pty', 'Nm')) ?? '';
  return emptyToNull(clean(name));
}

export function parseCamt053(xml: string): ParsedStatement {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (error) {
    return finish([], [], [{ row: 1, message: error instanceof XmlError ? error.message : 'The file could not be read as XML.' }], []);
  }
  const statements = findAll(root, 'Stmt');
  if (statements.length === 0 && root.name !== 'Stmt') {
    return finish([], [], [{ row: 1, message: 'This is not a bank statement in camt.053 form: no statement was found in it.' }], []);
  }
  const lines: ParsedLine[] = [];
  const skipped: ParsedStatement['skipped'] = [];
  const errors: ParsedStatement['errors'] = [];
  let opening: number | null = null;
  let closing: number | null = null;
  let n = 0;
  for (const stmt of statements.length === 0 ? [root] : statements) {
    for (const bal of stmt.children.filter((c) => c.name === 'Bal')) {
      const code = textAt(bal, 'Tp', 'CdOrPrtry', 'Cd');
      const cents = signedCents(child(bal, 'Amt'), textAt(bal, 'CdtDbtInd'), false);
      if (cents === null) continue;
      if ((code === 'OPBD' || code === 'PRCD') && opening === null) opening = cents;
      if (code === 'CLBD') closing = cents;
    }
    for (const entry of stmt.children.filter((c) => c.name === 'Ntry')) {
      n += 1;
      const status = entryStatus(entry);
      if (status !== 'BOOK') {
        skipped.push({ row: n, reason: `an entry that is ${status.toLowerCase()}, not booked` });
        continue;
      }
      const indicator = textAt(entry, 'CdtDbtInd');
      const reversal = textAt(entry, 'RvslInd').toLowerCase() === 'true';
      const cents = signedCents(child(entry, 'Amt'), indicator, reversal);
      if (cents === null) {
        errors.push({ row: n, message: `Entry ${String(n)}: the amount "${textAt(entry, 'Amt')}" could not be read.` });
        continue;
      }
      if (cents === 0) {
        skipped.push({ row: n, reason: 'no amount' });
        continue;
      }
      const date = dateOf(child(entry, 'BookgDt')) ?? dateOf(child(entry, 'ValDt'));
      if (!has(date)) {
        errors.push({ row: n, message: `Entry ${String(n)}: it has no booking date, and it has money in it.` });
        continue;
      }
      const credit = cents > 0;
      const txs = findAll(entry, 'TxDtls');
      const refs = txs.flatMap((t) => [textAt(t, 'Refs', 'EndToEndId'), textAt(t, 'Refs', 'TxId'), textAt(t, 'Refs', 'InstrId')]).filter((r) => r !== '' && r.toUpperCase() !== 'NOTPROVIDED');
      const reference = firstFilled(refs[0], textAt(entry, 'AcctSvcrRef'), textAt(entry, 'NtryRef'));
      const remittance = txs.flatMap((t) => findAll(t, 'Ustrd').map((u) => u.text.trim()).concat(textAt(t, 'AddtlTxInf')));
      const description = orElse(clean([...remittance, textAt(entry, 'AddtlNtryInf')].filter((x) => x !== '').join(' ')), clean(textAt(entry, 'NtryRef')));
      lines.push({ lineNo: 0, date, description, reference, counterparty: txs.length === 0 ? null : counterparty(txs[0], credit), amountCents: cents, balanceCents: null });
    }
  }
  if (lines.length === 0 && errors.length === 0) errors.push({ row: 1, message: 'No booked entries were found in the file.' });
  const res = finish(lines, skipped, errors, []);
  return { ...res, openingCents: opening, closingCents: closing };
}

/** True for a file that is a camt statement, so the import can tell it from other XML at a glance. */
export const looksLikeCamt = (text: string): boolean => /<(?:\w+:)?BkToCstmrStmt[\s>]/.test(text.slice(0, 5000)) || /camt\.05[23]/.test(text.slice(0, 2000));
