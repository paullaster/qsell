import { describe, expect, it } from 'vitest';
import { accountDetails, accountInput, accountNumberLine, blankAccountForm, editAccountForm, kindLabel } from './bank-account-form';
import { LINE_STATUS, booksNotYetSeen, canMatchTotal, emptyLinesText, entryType, fromCents, isDate, isOutgoing, pickedCents, plural, reconcile, ruleWords, toCents, toDealWith, twoPlaces, type PreviewLike } from './bank-statement';
import { BLANK_MAPPING, cleanMapping, importFields, importedMessage, lineLabel, mappingReady, pageHeaders, startingAmountMode, startingMapping, withDescription, withKeys } from './statement-import-form';

describe('bank account form', () => {
  const account = { id: 'a1', code: 'KCB', name: 'KCB main', kind: 'bank' as const, currency: 'KES', feeGlAccountId: 'g1', feeGlLabel: '6100 Bank charges', details: { bankName: 'KCB', accountNumber: '123', paybill: '999' } };

  it('starts blank, or from an existing account with its fee account named', () => {
    expect(blankAccountForm('KES')).toMatchObject({ id: null, kind: 'bank', currency: 'KES', fee: null });
    expect(editAccountForm(account)).toMatchObject({ id: 'a1', fee: { id: 'g1', label: '6100 Bank charges' }, bankName: 'KCB', accountNumber: '123', paybill: '999' });
    expect(editAccountForm({ ...account, feeGlAccountId: null, feeGlLabel: null, details: {} })).toMatchObject({ fee: null, bankName: '', paybill: '' });
    expect(kindLabel('cash')).toBe('Cash (till or drawer)');
    expect(kindLabel('odd')).toBe('odd');
  });

  it('sends only the details that belong to the kind', () => {
    const form = { ...editAccountForm(account), bankName: ' KCB ', paybill: '999' };
    expect(accountDetails(form)).toEqual({ bankName: 'KCB', accountNumber: '123' });
    expect(accountDetails({ ...form, kind: 'mobile_money' })).toEqual({ paybill: '999' });
    expect(accountDetails({ ...form, kind: 'cash' })).toEqual({});
    expect(accountInput({ ...form, currency: 'kes' })).toMatchObject({ name: 'KCB main', currency: 'KES', feeGlAccountId: 'g1' });
    expect(accountInput({ ...form, fee: null }).feeGlAccountId).toBeNull();
  });

  it('shows the paybill, else the account number', () => {
    expect(accountNumberLine({ paybill: '999', accountNumber: '1' })).toEqual({ label: 'Paybill / till', value: '999' });
    expect(accountNumberLine({ accountNumber: '1' })).toEqual({ label: 'Account no.', value: '1' });
    expect(accountNumberLine({})).toBeNull();
  });
});

describe('bank statement wording and arithmetic', () => {
  const preview: PreviewLike = { needsOpening: false, previous: { balance: '100.00' }, linesTotal: '50.25', blockingCount: 0, lineCount: 3, bookBalance: '200.00', outstandingNet: '25.50' };

  it('words states, entries and rules', () => {
    expect(LINE_STATUS.matched.label).toBe('Matched');
    expect(entryType('refund')).toBe('Refund');
    expect(entryType('odd')).toBe('odd');
    expect(ruleWords('amount:exact_ref')).toBe('amount exact ref');
    expect(plural(1, 'line', 'lines')).toBe('line');
    expect(plural(2, 'line', 'lines')).toBe('lines');
    expect(toDealWith({ unmatched: 2, proposed: 3 })).toBe(5);
    expect(isOutgoing('-5.00')).toBe(true);
    expect(isOutgoing('5.00')).toBe(false);
    expect(emptyLinesText('matched', 0)).toBe('Nothing here.');
    expect(emptyLinesText('open', 0)).toContain('No statement');
    expect(emptyLinesText('open', 2)).toContain('Every imported line');
    expect(isDate('2026-10-15')).toBe(true);
    expect(isDate('15/10/2026')).toBe(false);
    expect(twoPlaces('3')).toBe('3.00');
    expect(twoPlaces(null)).toBe('');
  });

  it('matches only when the ticked entries add up to the line exactly', () => {
    const entries = [{ id: 1, amount: '10.10' }, { id: 2, amount: '0.20' }, { id: 3, amount: '5.00' }];
    expect(pickedCents(entries, [1, 2])).toBe(1030);
    expect(canMatchTotal(1030, '10.30')).toBe(true);
    expect(canMatchTotal(1030, '10.31')).toBe(false);
    expect(canMatchTotal(0, '0')).toBe(false);
    expect(toCents('1.01')).toBe(101);
    expect(fromCents(1030)).toBe('10.30');
  });

  it('reconciles to the cent, only when nothing blocks it and the person may post', () => {
    expect(reconcile(preview, '', '150.25', true)).toMatchObject({ openingCents: 10000, expectedCents: 15025, diffCents: 0, canPost: true });
    expect(reconcile(preview, '', '150.00', true)).toMatchObject({ diffCents: -25, canPost: false });
    expect(reconcile(preview, '', '', true)).toMatchObject({ diffCents: null, canPost: false });
    expect(reconcile(preview, '', '150.25', false).canPost).toBe(false);
    expect(reconcile({ ...preview, blockingCount: 1 }, '', '150.25', true).canPost).toBe(false);
    expect(reconcile({ ...preview, lineCount: 0 }, '', '150.25', true).canPost).toBe(false);
    const first = { ...preview, needsOpening: true, previous: null };
    expect(reconcile(first, '', '150.25', true)).toMatchObject({ openingCents: null, expectedCents: null, canPost: false });
    expect(reconcile(first, '100.00', '150.25', true).canPost).toBe(true);
    expect(booksNotYetSeen(preview)).toBe('174.50');
  });
});

describe('statement import form', () => {
  const headers = ['Date', 'Details', 'Paid In', 'Withdrawn', 'Balance'];

  it('prefers a saved mapping that still fits the file, then the suggestion, then blank', () => {
    const saved = { ...BLANK_MAPPING, date: 'Date', description: ['Details'] };
    const suggested = { ...BLANK_MAPPING, date: 'Date', description: ['Details'], amount: 'Amt' };
    expect(startingMapping(saved, suggested, headers)).toBe(saved);
    expect(startingMapping({ ...saved, date: 'Booking date' }, suggested, headers)).toBe(suggested);
    expect(startingMapping(null, null, headers)).toBe(BLANK_MAPPING);
    expect(startingAmountMode(suggested)).toBe('single');
    expect(startingAmountMode(saved)).toBe('split');
  });

  it('says when enough columns are chosen', () => {
    const base = { ...BLANK_MAPPING, date: 'Date', description: ['Details'] };
    expect(mappingReady('mt940', BLANK_MAPPING, 'split')).toBe(true);
    expect(mappingReady('csv', BLANK_MAPPING, 'split')).toBe(false);
    expect(mappingReady('csv', base, 'split')).toBe(false);
    expect(mappingReady('csv', { ...base, paidIn: 'Paid In' }, 'split')).toBe(true);
    expect(mappingReady('csv', { ...base, paidIn: 'Paid In' }, 'single')).toBe(false);
    expect(mappingReady('csv', { ...base, amount: 'Amt' }, 'single')).toBe(true);
  });

  it('builds the mapping that is sent: no empty description columns, only the columns the layout uses', () => {
    const map = { ...BLANK_MAPPING, date: 'Date', description: ['Details', ''], amount: 'Amt', paidIn: 'In', withdrawn: 'Out' };
    expect(cleanMapping(map, 'single')).toMatchObject({ description: ['Details'], amount: 'Amt', paidIn: undefined, withdrawn: undefined });
    expect(cleanMapping(map, 'split')).toMatchObject({ amount: undefined, paidIn: 'In', withdrawn: 'Out' });
    expect(withDescription(BLANK_MAPPING, 0, 'Details').description).toEqual(['Details']);
    expect(withDescription({ ...BLANK_MAPPING, description: ['A', 'B'] }, 1, '').description).toEqual(['A']);
    const fields = importFields('csv', map, 'single', false);
    expect(fields).toMatchObject({ format: 'csv', headerRow: '1', saveFormat: '0' });
    expect(JSON.parse(fields.mapping)).toMatchObject({ amount: 'Amt' });
    expect(importedMessage({ lines: 1, duplicates: 0, autoMatched: 0, proposed: 1 })).toBe('Imported 1 line. 0 matched by themselves, 1 suggested.');
    expect(importedMessage({ lines: 5, duplicates: 2, autoMatched: 3, proposed: 1 })).toBe('Imported 5 lines (2 already there). 3 matched by themselves, 1 suggested.');
  });

  it('pages and searches a file’s column names, capping what the browser sent', () => {
    expect(pageHeaders(headers, '', null, 20).options.map((o) => o.id)).toEqual(headers);
    expect(pageHeaders(headers, 'PAID', null, 20).options.map((o) => o.id)).toEqual(['Paid In']);
    const first = pageHeaders(headers, '', null, 2);
    expect(first.options).toHaveLength(2);
    expect(first.nextCursor).toBe('2');
    const second = pageHeaders(headers, '', first.nextCursor, 2);
    expect(second.options.map((o) => o.id)).toEqual(['Paid In', 'Withdrawn']);
    expect(pageHeaders(headers, '', '4', 2).nextCursor).toBeNull();
    expect(pageHeaders(headers, '', 'junk', 2).options).toHaveLength(2);
    expect(pageHeaders(['a', 'a', '', 'b'], '', null, 20).options.map((o) => o.id)).toEqual(['a', 'b']);
    expect(pageHeaders(Array.from({ length: 500 }, (_, i) => `c${String(i)}`), '', null, 1000).options).toHaveLength(50);
    expect(pageHeaders(['x'.repeat(500)], '', null, 5).options[0]?.id).toHaveLength(120);
  });

  it('keys rows that have no id of their own and labels a line', () => {
    expect(withKeys(['a', 'b'], 'h').map((k) => k.key)).toEqual(['h-0', 'h-1']);
    expect(lineLabel('', 'REF')).toBe('REF');
    expect(lineLabel('', null)).toBe('');
    expect(lineLabel('Rent', 'REF')).toBe('Rent');
  });
});
