import { describe, expect, it } from 'vitest';
import { bankText, buildCsv, buildPain001, csvCell, lineProblem, sha256, xmlEscape, type FileLine } from './refund-file';

const line = (o: Partial<FileLine> = {}): FileLine => ({ endToEndId: 'RFD-26-00000001', amountCents: 125050, beneficiary: { name: 'Jane Wanjiru', bank: 'KCB', account: '1234567890' }, narrative: 'Refund RFD-26-00000001', ...o });

describe('text a bank file can carry', () => {
  it('keeps plain characters and turns the rest into single spaces', () => {
    expect(bankText('  Jané   Wanjiru  <x>  ', 70)).toBe('Jan Wanjiru x');
    expect(bankText('A'.repeat(100), 10)).toBe('AAAAAAAAAA');
    expect(xmlEscape(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
  });

  it('defuses spreadsheet formulas and quotes cells with commas, quotes or line breaks', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+254700')).toBe("'+254700");
    expect(csvCell('Wanjiru, Jane')).toBe('"Wanjiru, Jane"');
    expect(csvCell('plain')).toBe('plain');
  });
});

describe('the CSV file', () => {
  it('has a header, one row per refund, and the amount in whole units with two places', () => {
    const csv = buildCsv([line(), line({ endToEndId: 'RFD-2', amountCents: 5, beneficiary: { name: 'Bob', bank: 'Equity', account: '99' } })], 'KES');
    expect(csv.split('\r\n')).toEqual([
      'Reference,Beneficiary name,Bank,Account number,Amount,Currency,Narrative',
      'RFD-26-00000001,Jane Wanjiru,KCB,1234567890,1250.50,KES,Refund RFD-26-00000001',
      'RFD-2,Bob,Equity,99,0.05,KES,Refund RFD-26-00000001',
      '',
    ]);
  });

  it('is the same file every time for the same lines', () => {
    expect(sha256(buildCsv([line()], 'KES'))).toBe(sha256(buildCsv([line()], 'KES')));
    expect(sha256(buildCsv([line()], 'KES'))).not.toBe(sha256(buildCsv([line({ amountCents: 1 })], 'KES')));
  });
});

describe('the ISO 20022 file', () => {
  const xml = buildPain001({ messageId: 'RPF-26-000001', createdAt: new Date('2026-10-17T09:30:15.000Z'), executionDate: '2026-10-18', debtor: { name: 'Acme Ltd', account: '0011223344' }, currency: 'KES', lines: [line(), line({ endToEndId: 'RFD-2', amountCents: 5000, beneficiary: { name: 'Bob & Sons <Ltd>', bank: 'Equity', account: '99' } })] });

  it('carries the count and the control sum the bank checks', () => {
    expect(xml).toContain('<NbOfTxs>2</NbOfTxs>');
    expect(xml).toContain('<CtrlSum>1300.50</CtrlSum>');
    expect(xml).toContain('<ReqdExctnDt>2026-10-18</ReqdExctnDt>');
    expect(xml).toContain('<CreDtTm>2026-10-17T09:30:15</CreDtTm>');
    expect(xml).toContain('<MsgId>RPF-26-000001</MsgId>');
  });

  it('puts each beneficiary in, with nothing that could break out of the markup', () => {
    expect(xml).toContain('<InstdAmt Ccy="KES">1250.50</InstdAmt>');
    expect(xml).toContain('<Nm>Bob &amp; Sons Ltd</Nm>');
    expect(xml).not.toContain('<Ltd>');
    expect(xml.match(/<CdtTrfTxInf>/g)).toHaveLength(2);
  });
});

describe('which refunds can go into a file', () => {
  const ok = { number: 'RFD-1', currency: 'KES', kind: 'bank_transfer', details: { bankName: 'KCB', accountNumber: '1', accountName: 'A' } };
  it('only bank transfers in the file\'s currency with the bank, account and name', () => {
    expect(lineProblem(ok, 'KES')).toBeNull();
    expect(lineProblem({ ...ok, kind: 'mobile_money' }, 'KES')).toContain('not paid by bank transfer');
    expect(lineProblem({ ...ok, currency: 'USD' }, 'KES')).toContain('in USD');
    expect(lineProblem({ ...ok, details: { ...ok.details, accountNumber: '   ' } }, 'KES')).toBe('RFD-1 is missing an account number.');
    expect(lineProblem({ ...ok, details: { bankName: 'KCB', accountNumber: '1' } }, 'KES')).toContain('an account name');
  });
});
