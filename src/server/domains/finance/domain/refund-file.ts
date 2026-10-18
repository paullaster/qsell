import { createHash } from 'node:crypto';

import { fromCents } from './receivables';

/**
 * Bank payment files for refunds: what goes in the file, built from plain data. Pure: the same lines
 * always make the same file, so a file can be checked against its hash and rebuilt for an auditor.
 */
export interface FileLine {
  /** Our own reference for the payment (the refund number); the bank gives it back on its statement. */
  endToEndId: string;
  amountCents: number;
  beneficiary: { name: string; bank: string; account: string };
  narrative: string;
}

export const MAX_FILE_LINES = 500;

/** Characters a bank file may carry safely; anything else becomes a space. */
const SAFE = /[^A-Za-z0-9 /\-?:().,'+&]/g;

/** Text a bank will accept: plain characters, no runs of spaces, cut to length. */
export function bankText(text: string, max: number): string {
  return text.replace(SAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A cell that a spreadsheet might read as a formula is made harmless. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildCsv(lines: readonly FileLine[], currency: string): string {
  const header = ['Reference', 'Beneficiary name', 'Bank', 'Account number', 'Amount', 'Currency', 'Narrative'];
  const rows = lines.map((l) => [l.endToEndId, l.beneficiary.name, l.beneficiary.bank, l.beneficiary.account, fromCents(l.amountCents), currency, l.narrative]);
  return `${[header, ...rows].map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n')}\r\n`;
}

export const xmlEscape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface Pain001Input {
  messageId: string;
  createdAt: Date;
  executionDate: string;
  debtor: { name: string; account: string };
  currency: string;
  lines: readonly FileLine[];
}

/** ISO 20022 customer credit transfer initiation (pain.001.001.03): the format most banks accept for bulk payments. */
export function buildPain001(p: Pain001Input): string {
  const total = p.lines.reduce((n, l) => n + l.amountCents, 0);
  const tx = p.lines
    .map(
      (l) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${xmlEscape(bankText(l.endToEndId, 35))}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${xmlEscape(p.currency)}">${fromCents(l.amountCents)}</InstdAmt></Amt>
        <Cdtr><Nm>${xmlEscape(bankText(l.beneficiary.name, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><Othr><Id>${xmlEscape(bankText(l.beneficiary.account, 34))}</Id></Othr></Id></CdtrAcct>
        <RmtInf><Ustrd>${xmlEscape(bankText(`${l.narrative} ${l.beneficiary.bank}`, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xmlEscape(bankText(p.messageId, 35))}</MsgId>
      <CreDtTm>${p.createdAt.toISOString().slice(0, 19)}</CreDtTm>
      <NbOfTxs>${String(p.lines.length)}</NbOfTxs>
      <CtrlSum>${fromCents(total)}</CtrlSum>
      <InitgPty><Nm>${xmlEscape(bankText(p.debtor.name, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xmlEscape(bankText(p.messageId, 35))}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${String(p.lines.length)}</NbOfTxs>
      <CtrlSum>${fromCents(total)}</CtrlSum>
      <ReqdExctnDt>${p.executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${xmlEscape(bankText(p.debtor.name, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${xmlEscape(bankText(p.debtor.account, 34))}</Id></Othr></Id></DbtrAcct>
${tx}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface Problem {
  refundNumber: string;
  message: string;
}

/** Whether a refund can go into a bank file, and why not when it cannot. */
export function lineProblem(r: { number: string; currency: string; kind: string; details: Record<string, string> }, fileCurrency: string): string | null {
  if (r.kind !== 'bank_transfer') return `${r.number} is not paid by bank transfer.`;
  if (r.currency !== fileCurrency) return `${r.number} is in ${r.currency}; this file is in ${fileCurrency}.`;
  for (const [key, label] of [['bankName', 'a bank'], ['accountNumber', 'an account number'], ['accountName', 'an account name']] as const) {
    if (bankText(r.details[key] ?? '', 70) === '') return `${r.number} is missing ${label}.`;
  }
  return null;
}
