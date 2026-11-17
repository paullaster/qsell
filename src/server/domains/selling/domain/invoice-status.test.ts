import { describe, expect, it } from 'vitest';
import { INVOICE_KIND_WORDS, isInvoiceKind, paymentStateOf, signingStateOf } from './invoice-status';

describe('how an invoice stands', () => {
  it('reads the latest signing event: a transmission that signed is signed, a decision to sign is still being signed, and refusals and waits are said so', () => {
    expect(signingStateOf({ eventType: 'transmission', outcome: 'sign' })).toBe('signed');
    expect(signingStateOf({ eventType: 'decision', outcome: 'sign' })).toBe('being_signed');
    expect(signingStateOf({ eventType: 'transmission', outcome: 'fail' })).toBe('failed');
    expect(signingStateOf({ eventType: 'decision', outcome: 'skip' })).toBe('not_signed');
    expect(signingStateOf({ eventType: 'decision', outcome: 'defer' })).toBe('waiting');
    expect(signingStateOf(null)).toBe('unknown');
    expect(signingStateOf({ eventType: 'decision', outcome: 'something_new' })).toBe('unknown');
  });

  it('puts a fully credited invoice first, then follows the order\'s payment state', () => {
    expect(paymentStateOf(1000, 1000, 'paid')).toBe('credited');
    expect(paymentStateOf(1000, 400, 'paid')).toBe('paid');
    expect(paymentStateOf(1000, 0, 'reconciled')).toBe('paid');
    expect(paymentStateOf(1000, 0, 'partially_paid')).toBe('partly_paid');
    expect(paymentStateOf(1000, 0, 'unpaid')).toBe('unpaid');
    expect(paymentStateOf(1000, 0, null)).toBe('unpaid');
  });

  it('names the kinds of invoice', () => {
    expect(INVOICE_KIND_WORDS.tax_invoice).toBe('Tax invoice');
    expect(isInvoiceKind('proforma')).toBe(true);
    expect(isInvoiceKind('receipt')).toBe(false);
  });
});
