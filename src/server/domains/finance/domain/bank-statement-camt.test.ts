import { describe, expect, it } from 'vitest';
import { looksLikeCamt, parseCamt053 } from './bank-statement-camt';

const wrap = (body: string, ns = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.02') => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="${ns}"><BkToCstmrStmt><GrpHdr><MsgId>M1</MsgId></GrpHdr>${body}</BkToCstmrStmt></Document>`;

const stmt = `<Stmt><Id>S1</Id>
  <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="KES">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-01</Dt></Dt></Bal>
  <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="KES">1325.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-03</Dt></Dt></Bal>
  <Ntry><NtryRef>N1</NtryRef><Amt Ccy="KES">500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-02</Dt></BookgDt><AcctSvcrRef>BANKREF1</AcctSvcrRef>
    <NtryDtls><TxDtls><Refs><EndToEndId>PAY-26-00000042</EndToEndId></Refs><RltdPties><Dbtr><Nm>Jane Wanjiru</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Invoice 77</Ustrd><Ustrd>thanks</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="KES">174.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><DtTm>2026-10-03T09:15:00</DtTm></BookgDt><AcctSvcrRef>BANKREF2</AcctSvcrRef>
    <NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><RltdPties><Cdtr><Nm>Bob &amp; Sons</Nm></Cdtr></RltdPties></TxDtls></NtryDtls><AddtlNtryInf>Charges</AddtlNtryInf></Ntry>
</Stmt>`;

describe('a camt.053 statement', () => {
  it('reads booked entries with their sign, date, reference, other party and text, and the bank\'s balances', () => {
    const p = parseCamt053(wrap(stmt));
    expect(p.errors).toEqual([]);
    expect(p.openingCents).toBe(100000);
    expect(p.closingCents).toBe(132550);
    expect(p.lines).toMatchObject([
      { date: '2026-10-02', amountCents: 50000, reference: 'PAY-26-00000042', counterparty: 'Jane Wanjiru', description: 'Invoice 77 thanks' },
      { date: '2026-10-03', amountCents: -17450, reference: 'BANKREF2', counterparty: 'Bob & Sons', description: 'Charges' },
    ]);
    expect(p.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it('works in the newer layout, where the status and the dates are nested differently', () => {
    const body = `<Stmt><Ntry><Amt Ccy="KES">20.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><DtTm>2026-10-04T10:00:00+03:00</DtTm></BookgDt><NtryDtls><TxDtls><Refs><TxId>TX9</TxId></Refs><RltdPties><Dbtr><Pty><Nm>Ann</Nm></Pty></Dbtr></RltdPties></TxDtls></NtryDtls></Ntry></Stmt>`;
    const p = parseCamt053(wrap(body, 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08'));
    expect(p.lines).toMatchObject([{ date: '2026-10-04', amountCents: 2000, reference: 'TX9', counterparty: 'Ann' }]);
  });

  it('turns a reversal around, leaves out entries that are not booked, and joins several statements', () => {
    const body = `<Stmt><Ntry><Amt Ccy="KES">30.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>true</RvslInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-02</Dt></BookgDt><AcctSvcrRef>R1</AcctSvcrRef></Ntry>
      <Ntry><Amt Ccy="KES">99.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts><BookgDt><Dt>2026-10-02</Dt></BookgDt></Ntry></Stmt>
      <Stmt><Ntry><Amt Ccy="KES">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><ValDt><Dt>2026-10-05</Dt></ValDt><AcctSvcrRef>R2</AcctSvcrRef></Ntry></Stmt>`;
    const p = parseCamt053(wrap(body));
    expect(p.lines.map((l) => [l.date, l.amountCents])).toEqual([['2026-10-02', -3000], ['2026-10-05', 500]]);
    expect(p.skipped).toEqual([{ row: 2, reason: 'an entry that is pdng, not booked' }]);
  });

  it('refuses, with the row, an entry whose money or date cannot be read', () => {
    const bad = parseCamt053(wrap(`<Stmt><Ntry><Amt Ccy="KES">abc</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-02</Dt></BookgDt></Ntry><Ntry><Amt Ccy="KES">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts></Ntry></Stmt>`));
    expect(bad.errors.map((e) => e.row)).toEqual([1, 2]);
    expect(bad.errors[0].message).toContain('amount');
    expect(bad.errors[1].message).toContain('booking date');
  });

  it('refuses files that are not statements, that are not XML, or that carry a document type', () => {
    expect(parseCamt053('<a><b/></a>').errors[0].message).toContain('not a bank statement');
    expect(parseCamt053('not xml at all').errors).toHaveLength(1);
    expect(parseCamt053('<!DOCTYPE r [<!ENTITY x "1">]><r/>').errors[0].message).toContain('document type');
    expect(parseCamt053(wrap('<Stmt></Stmt>')).errors[0].message).toContain('No booked entries');
  });

  it('is recognised from its start', () => {
    expect(looksLikeCamt(wrap(stmt))).toBe(true);
    expect(looksLikeCamt('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.02"/>')).toBe(true);
    expect(looksLikeCamt('Date,Amount\n1,2')).toBe(false);
  });
});
