import { describe, expect, it } from 'vitest';
import { fieldHint, fieldInputMode, fieldText, operationInput, parseAddressList, parsePollSeconds, runButtonLabel, settingsPatch } from './mpesa-settings-form';

describe('mpesa settings form', () => {
  it('reads the ask-again schedule and drops what is not a positive number', () => {
    expect(parsePollSeconds('15, 45,120')).toEqual([15, 45, 120]);
    expect(parsePollSeconds('x, -3, 0, 7')).toEqual([7]);
    expect(parsePollSeconds('')).toEqual([]);
  });

  it('reads addresses split by lines or commas', () => {
    expect(parseAddressList('1.2.3.4\n 5.6.7.0/24 ,\n\n')).toEqual(['1.2.3.4', '5.6.7.0/24']);
  });

  it('builds the settings patch, with empty limits as null and a default window', () => {
    const patch = settingsPatch({
      mode: 'strict', windowMinutes: '', poll: '10', cidrs: '', responseType: 'Cancelled', validation: 'reject_all', autoAllocate: 'off', dailyLimit: ' ',
      operations: { b2c: { enabled: true, maxAmount: ' 500 ' }, qr_generate: { enabled: false, maxAmount: '' } },
    });
    expect(patch).toEqual({
      verification: { mode: 'strict', windowMinutes: 120, pollSeconds: [10] },
      security: { allowedCidrs: [] },
      c2b: { responseType: 'Cancelled', validation: 'reject_all', autoAllocate: 'off' },
      dailyPayoutLimit: null,
      operations: { b2c: { enabled: true, maxAmount: '500' }, qr_generate: { enabled: false, maxAmount: null } },
    });
  });

  it('builds an operation input from typed values and defaults, leaving blanks out', () => {
    const fields = [{ key: 'amount' }, { key: 'trxCode', defaultValue: 'BG' }, { key: 'note' }];
    expect(operationInput(fields, { 'qr.amount': ' 10 ', 'qr.note': '  ' }, 'qr')).toEqual({ amount: '10', trxCode: 'BG' });
  });

  it('upper-cases a transaction code only', () => {
    expect(fieldText('transactionId', 'abc12')).toBe('ABC12');
    expect(fieldText('phone', 'abc')).toBe('abc');
  });
});

describe('field presentation', () => {
  it('picks the keyboard, the hint and the button words', () => {
    expect(fieldInputMode('phone')).toBe('tel');
    expect(fieldInputMode('number')).toBe('decimal');
    expect(fieldInputMode('text')).toBeUndefined();
    expect(fieldHint({ hint: 'Own' })).toBe('Own');
    expect(fieldHint({ patternHint: 'a 5 digit number' })).toBe('Use a 5 digit number.');
    expect(fieldHint({})).toBeUndefined();
    expect(runButtonLabel(true, false)).toBe('Working…');
    expect(runButtonLabel(false, true)).toBe('Request approval');
    expect(runButtonLabel(false, false)).toBe('Run');
  });
});
