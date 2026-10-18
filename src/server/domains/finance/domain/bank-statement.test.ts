import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type MatchRules } from './bank-match';
import {
  MPESA_MAPPING,
  parseCsv,
  parseCsvStatement,
  parseDate,
  parseMoney,
  parseMt940,
  reconciliationDifference,
  suggestMatches,
  withHashes,
  type EntryForMatch,
  type LineForMatch,
} from './bank-statement';

describe('reading dates and amounts', () => {
  it('reads the ways banks write dates, day first', () => {
    expect(parseDate('2026-10-13')).toBe('2026-10-13');
    expect(parseDate('13/10/2026')).toBe('2026-10-13');
    expect(parseDate('13-10-26')).toBe('2026-10-13');
    expect(parseDate('13 Oct 2026')).toBe('2026-10-13');
    // a date typed into Excel is a count of days
    expect(parseDate('46312')).toBe('2026-10-17');
    expect(parseDate('46312.5416667')).toBe('2026-10-17');
    expect(parseDate('12345')).toBeNull();
    expect(parseDate('99999')).toBeNull();
    expect(parseDate('13-Oct-2026 14:22:01')).toBe('2026-10-13');
    expect(parseDate('2026-10-13 14:22:01')).toBe('2026-10-13');
    expect(parseDate('10/13/2026', 'mdy')).toBe('2026-10-13');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('Total')).toBeNull();
  });
  it('reads amounts in the ways banks write them', () => {
    expect(parseMoney('1,234.50')).toBe(123450);
    expect(parseMoney('(120.00)')).toBe(-12000);
    expect(parseMoney('KES 5,000')).toBe(500000);
    expect(parseMoney('300.00 DR')).toBe(-30000);
    expect(parseMoney('300.00 CR')).toBe(30000);
    expect(parseMoney('-45')).toBe(-4500);
    expect(parseMoney('45-')).toBe(-4500);
    expect(parseMoney('1.234,50')).toBeNull(); // two separators the wrong way round is refused, not guessed
    expect(parseMoney('12,5')).toBe(1250);
    expect(parseMoney('1,000')).toBe(100000);
    expect(parseMoney('1.005')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
  it('reads quoted cells, doubled quotes and other delimiters', () => {
    expect(parseCsv('a,"b,1","c ""q"""\n1,2,3')).toEqual([['a', 'b,1', 'c "q"'], ['1', '2', '3']]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('reading a CSV statement', () => {
  const csv = 'Date,Narration,Ref,Debit,Credit,Balance\n01/10/2026,Opening,,,,1000.00\n02/10/2026,PAY-1 Acme,PAY-1,,500.00,1500.00\n03/10/2026,Fee,,20.00,,1480.00\n,TOTAL,,20.00,500.00,\n';
  const map = { headerRow: 1, date: 'Date', description: ['Narration'], reference: 'Ref', paidIn: 'Credit', withdrawn: 'Debit', balance: 'Balance' };
  it('reads lines, skips totals and the opening row, and works out opening and closing', () => {
    const r = parseCsvStatement(csv, map);
    expect(r.errors).toEqual([]);
    expect(r.lines.map((l) => [l.date, l.amountCents])).toEqual([['2026-10-02', 50000], ['2026-10-03', -2000]]);
    expect(r.openingCents).toBe(100000);
    expect(r.skipped.map((x) => x.row)).toEqual([2, 5]);
  });
  it('knows the opening and closing balance when every line has one, and notices a break', () => {
    const ok = parseCsvStatement('d,t,a,b\n02/10/2026,x,500.00,1500.00\n03/10/2026,y,-20.00,1480.00', { headerRow: 1, date: 'd', description: ['t'], amount: 'a', balance: 'b' });
    expect(ok.openingCents).toBe(100000);
    expect(ok.closingCents).toBe(148000);
    expect(ok.balanceBreaks).toEqual([]);
    const broken = parseCsvStatement('d,t,a,b\n02/10/2026,x,500.00,1500.00\n03/10/2026,y,-20.00,1400.00', { headerRow: 1, date: 'd', description: ['t'], amount: 'a', balance: 'b' });
    expect(broken.balanceBreaks).toEqual([2]);
  });
  it('puts a newest-first file in order', () => {
    const r = parseCsvStatement('d,t,a\n03/10/2026,y,-20.00\n02/10/2026,x,500.00', { headerRow: 1, date: 'd', description: ['t'], amount: 'a' });
    expect(r.lines.map((l) => l.date)).toEqual(['2026-10-02', '2026-10-03']);
    expect(r.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });
  it('refuses a row with money but an unreadable date or amount, and a missing column, instead of dropping it', () => {
    expect(parseCsvStatement('d,t,a\nsoon,x,500.00', { headerRow: 1, date: 'd', description: ['t'], amount: 'a' }).errors[0].message).toMatch(/date "soon"/);
    expect(parseCsvStatement('d,t,a\n02/10/2026,x,5oo', { headerRow: 1, date: 'd', description: ['t'], amount: 'a' }).errors[0].message).toMatch(/amount "5oo"/);
    expect(parseCsvStatement('d,t,a\n02/10/2026,x,5', { headerRow: 1, date: 'when', description: ['t'], amount: 'a' }).errors[0].message).toMatch(/"when" is not in the file/);
    expect(parseCsvStatement('d,t\n02/10/2026,x', { headerRow: 1, date: 'd', description: ['t'] }).errors[0].message).toMatch(/amount column/);
  });
  it('reads an M-Pesa export', () => {
    const r = parseCsvStatement('Receipt No.,Completion Time,Details,Paid In,Withdrawn,Balance\nSJK1ABC2D3,2026-10-13 14:22:01,Funds received from 2547XXXXXXXX - JANE,1500.00,,6500.00\nSJK1ABC2D4,2026-10-13 15:00:00,Charge,,33.00,6467.00', MPESA_MAPPING);
    expect(r.errors).toEqual([]);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ reference: 'SJK1ABC2D3', amountCents: 150000, date: '2026-10-13' });
    expect(r.lines[1].amountCents).toBe(-3300);
    expect(r.openingCents).toBe(500000);
  });
  it('gives identical real lines in one file different fingerprints, and the same line the same one again', () => {
    const l = { date: '2026-10-02', amountCents: 100, reference: null, description: 'Same' };
    const a = withHashes([l, l]);
    expect(a[0].lineHash).not.toBe(a[1].lineHash);
    expect(withHashes([l])[0].lineHash).toBe(a[0].lineHash);
  });
});

describe('reading MT940', () => {
  it('reads balances, credits, debits and narrative', () => {
    const r = parseMt940(':20:STMT\n:25:0123\n:60F:C261001KES1000,00\n:61:2610020102C500,00NTRFPAY-1//BANKREF1\n:86:Transfer from Acme PAY-1\n:61:2610030103D20,00NCHGNONREF\n:86:Bank charge\n:62F:C261003KES1480,00\n');
    expect(r.errors).toEqual([]);
    expect(r.lines.map((l) => [l.date, l.amountCents, l.reference])).toEqual([['2026-10-02', 50000, 'BANKREF1'], ['2026-10-03', -2000, 'NONREF']]);
    expect(r.lines[0].description).toBe('Transfer from Acme PAY-1');
    expect(r.openingCents).toBe(100000);
    expect(r.closingCents).toBe(148000);
  });
});

describe('matching lines to ledger entries', () => {
  const entry = (id: number, date: string, amountCents: number, refs: string[] = []) => ({ id, date, amountCents, refs });
  const line = (id: number, date: string, amountCents: number, description = '', reference: string | null = null) => ({ id, date, amountCents, description, reference });
  it('a quoted reference with the same amount is matched by itself', () => {
    const s = suggestMatches([line(1, '2026-10-05', 50000, 'Transfer PAY-26-0000000001 Acme')], [entry(10, '2026-10-02', 50000, ['PAY-26-0000000001']), entry(11, '2026-10-02', 50000, ['PAY-26-0000000002'])]);
    expect(s).toEqual([{ lineId: 1, entryIds: [10], rule: 'reference', certainty: 'matched' }]);
  });
  it('same amount close in time is only proposed, nearest first, and never beyond the window', () => {
    const s = suggestMatches([line(1, '2026-10-05', 700)], [entry(10, '2026-10-01', 700), entry(11, '2026-10-04', 700), entry(12, '2026-10-20', 700)]);
    expect(s).toEqual([{ lineId: 1, entryIds: [11], rule: 'amount_date', certainty: 'proposed' }]);
    const two = suggestMatches([line(1, '2026-10-05', 700)], [entry(10, '2026-10-03', 700), entry(11, '2026-10-04', 700)]);
    expect(two[0].entryIds).toEqual([11, 10]);
  });
  it('a different amount never matches, and a certain match uses its entry only once', () => {
    expect(suggestMatches([line(1, '2026-10-05', 701, 'PAY-1')], [entry(10, '2026-10-05', 700, ['PAY-1'])])).toEqual([]);
    const s = suggestMatches([line(1, '2026-10-05', 700, 'PAY-0001'), line(2, '2026-10-05', 700, 'PAY-0001')], [entry(10, '2026-10-05', 700, ['PAY-0001'])]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ lineId: 1, certainty: 'matched' });
  });
  it('short references are not trusted (too easy to appear by chance)', () => {
    const s = suggestMatches([line(1, '2026-10-05', 700, 'ref 12 paid')], [entry(10, '2026-10-05', 700, ['12'])]);
    expect(s[0]).toMatchObject({ certainty: 'proposed', rule: 'amount_date' });
  });
  it('money out matches money out', () => {
    const s = suggestMatches([line(1, '2026-10-05', -58000, 'refund RFD-26-00000001')], [entry(10, '2026-10-04', -58000, ['RFD-26-00000001'])]);
    expect(s[0]).toMatchObject({ entryIds: [10], certainty: 'matched' });
  });
});

describe('the reconciliation sum', () => {
  it('opening plus the lines closed equals the statement, or says by how much not', () => {
    expect(reconciliationDifference(100000, [50000, -2000], 148000)).toEqual({ total: 48000, expected: 148000, difference: 0 });
    expect(reconciliationDifference(100000, [50000], 148000).difference).toBe(-2000);
  });
});

describe('matching by the rules in force', () => {
  const line = (o: Partial<LineForMatch> = {}): LineForMatch => ({ id: 1, date: '2026-10-10', amountCents: 50000, description: 'MPESA from 254722123456 JANE WANJIRU', reference: 'QWE123XYZ', ...o });
  const entry = (o: Partial<EntryForMatch> = {}): EntryForMatch => ({ id: 10, date: '2026-10-09', amountCents: 50000, refs: ['PAY-26-00000001'], phones: ['722123456'], names: ['Jane Wanjiru'], ...o });
  const rules = (o: Partial<MatchRules> = {}): MatchRules => ({ ...DEFAULT_RULES, ...o });

  it('with the standard rules a phone number and a name change nothing', () => {
    expect(suggestMatches([line()], [entry()])).toEqual([{ lineId: 1, entryIds: [10], rule: 'amount_date', certainty: 'proposed' }]);
  });

  it('a phone number the customer owns can be suggested, or trusted to close the line, when the rules say so', () => {
    const far = entry({ date: '2026-09-01' });
    expect(suggestMatches([line()], [far], { rules: rules({ phone: 'propose' }) })).toEqual([{ lineId: 1, entryIds: [10], rule: 'phone', certainty: 'proposed' }]);
    expect(suggestMatches([line()], [far], { rules: rules({ phone: 'auto' }) })).toEqual([{ lineId: 1, entryIds: [10], rule: 'phone', certainty: 'matched' }]);
    // never by itself when two customers share the number, or the amount is not exact
    expect(suggestMatches([line()], [far, entry({ id: 11, date: '2026-09-02' })], { rules: rules({ phone: 'auto' }) })[0].certainty).toBe('proposed');
    expect(suggestMatches([line({ amountCents: 50010 })], [far], { rules: rules({ phone: 'auto', amountToleranceCents: 50 }) })[0].certainty).toBe('proposed');
    expect(suggestMatches([line({ description: 'MPESA from 254799000111' })], [far], { rules: rules({ phone: 'auto' }) })).toEqual([]);
  });

  it('a payer name that resembles the customer is only ever a suggestion', () => {
    const out = suggestMatches([line({ description: 'Transfer', counterparty: 'WANJIRU JANE' })], [entry({ date: '2026-09-20', phones: [] })], { rules: rules({ name: 'propose', dateWindowDays: 0 }) });
    expect(out).toEqual([{ lineId: 1, entryIds: [10], rule: 'name', certainty: 'proposed' }]);
    expect(suggestMatches([line({ description: 'Transfer', counterparty: 'Bob Otieno' })], [entry({ date: '2026-09-20' })], { rules: rules({ name: 'propose', dateWindowDays: 0 }) })).toEqual([]);
  });

  it('an amount close but not equal is suggested only when a tolerance is allowed', () => {
    expect(suggestMatches([line({ amountCents: 50030 })], [entry()])).toEqual([]);
    expect(suggestMatches([line({ amountCents: 50030 })], [entry()], { rules: rules({ amountToleranceCents: 50 }) })).toEqual([{ lineId: 1, entryIds: [10], rule: 'amount_date', certainty: 'proposed' }]);
  });

  it('quoting our reference closes the line by itself only if the rules trust it; otherwise it is a suggestion', () => {
    const quoting = line({ reference: 'PAY-26-00000001' });
    expect(suggestMatches([quoting], [entry()])[0]).toMatchObject({ rule: 'reference', certainty: 'matched' });
    expect(suggestMatches([quoting], [entry()], { rules: rules({ reference: 'propose' }) })[0]).toMatchObject({ rule: 'reference', certainty: 'proposed' });
    expect(suggestMatches([quoting], [entry({ date: '2026-01-01' })], { rules: rules({ reference: 'off' }) })).toEqual([]);
    expect(suggestMatches([quoting], [entry({ refs: ['PAY1'] })], { rules: rules({ minRefLength: 3 }) }).length).toBe(1);
  });

  it('shows at most as many entries as the rules allow, strongest evidence first', () => {
    const entries = [1, 2, 3, 4].map((i) => entry({ id: i, date: `2026-10-0${String(i + 4)}` }));
    expect(suggestMatches([line()], entries, { rules: rules({ maxProposals: 2 }) })[0].entryIds).toHaveLength(2);
  });
});
