import { describe, expect, it } from 'vitest';
import { billRequestLabel, countTone, rowDetail, rowState, rowTitle, shortReason, when, words } from './payment-activity-format';

describe('payment activity format', () => {
  it('prints only the facts a row has, in order', () => {
    const row = { provider: 'M-Pesa', reference: 'ABC123', amount: '150.00', shortcode: '600100', duplicate: true, attempts: 2, ip: null, method: '' };
    expect(rowDetail(row, (a) => `KES ${a}`)).toBe(' · M-Pesa · ABC123 · KES 150.00 · to 600100 · a repeat of an earlier one · 2 attempt(s)');
    expect(rowDetail({}, String)).toBe('');
  });

  it('titles a row by its operation or kind, and states it by status or state', () => {
    expect(rowTitle({ operation: 'stk_push' })).toBe('stk push');
    expect(rowTitle({ kind: 'c2b_confirm' })).toBe('c2b confirm');
    expect(rowState({ status: 'failed', state: 'x' })).toBe('failed');
    expect(rowState({ state: 'verified' })).toBe('verified');
  });

  it('writes times and words', () => {
    expect(when(null)).toBe('');
    expect(when('')).toBe('');
    expect(when('2026-10-14T10:00:00Z')).not.toBe('');
    expect(words('in_doubt')).toBe('in doubt');
  });

  it('colours a count only when it needs a look', () => {
    expect(countTone(3, 'red')).toBe('text-red-700');
    expect(countTone(3, 'amber')).toBe('text-amber-700');
    expect(countTone(0, 'red')).toBe('text-fg-strong');
    expect(countTone(5, 'green')).toBe('text-fg-strong');
  });

  it('labels a Bill Manager request', () => {
    expect(billRequestLabel({ operation: 'bill_invoice_bulk', count: 3, reference: null })).toBe('bill invoice bulk · 3 invoices');
    expect(billRequestLabel({ operation: 'bill_cancel', count: 1, reference: 'INV-1' })).toBe('bill cancel · INV-1');
    expect(billRequestLabel({ operation: 'bill_cancel', count: 1, reference: null })).toBe('bill cancel');
    expect(shortReason(null, 5)).toBe('');
    expect(shortReason('abcdefgh', 5)).toBe('abcde');
  });
});
