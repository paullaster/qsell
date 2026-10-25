import { describe, expect, it } from 'vitest';
import { SettlementError, discountOpen, settle, settlementJournal, type SettlementLineInput, type SettlementTerms } from './vendor-settlement';

const line = (over: Partial<SettlementLineInput> = {}): SettlementLineInput => ({ purchaseInvoiceId: 'a', grossCents: 46400, invoiceDate: '2026-10-01', invoiceTotalCents: 46400, invoiceSubtotalCents: 40000, openCents: 46400, closeRemainder: false, ...over });
const terms = (over: Partial<SettlementTerms> = {}): SettlementTerms => ({ discountPercent: 0, discountDays: 0, withholding: null, toleranceCents: 0, asOf: '2026-10-10', ...over });

describe('a plain payment', () => {
  it('pays the whole amount in cash', () => {
    const s = settle([line()], terms());
    expect(s).toMatchObject({ grossCents: 46400, cashCents: 46400, discountCents: 0, withholdingCents: 0, toleranceCents: 0, clearedCents: 46400 });
    expect(settlementJournal(s)).toEqual([{ side: 'debit', purpose: 'payables', cents: 46400 }, { side: 'credit', purpose: 'cash', cents: 46400 }]);
  });
  it('refuses nonsense', () => {
    expect(() => settle([line({ grossCents: 0 })], terms())).toThrow(SettlementError);
    expect(() => settle([line({ grossCents: 46401 })], terms())).toThrow(/more than is open/);
  });
});

describe('early-payment discount', () => {
  it('is taken inside the days and not after', () => {
    const t = terms({ discountPercent: 2, discountDays: 10, asOf: '2026-10-11' });
    expect(discountOpen(t, '2026-10-01')).toBe(true);
    expect(discountOpen({ ...t, asOf: '2026-10-12' }, '2026-10-01')).toBe(false);
    expect(settle([line()], t).discountCents).toBe(928);
    expect(settle([line()], { ...t, asOf: '2026-10-12' }).discountCents).toBe(0);
    expect(discountOpen(terms({ discountPercent: 0, discountDays: 10 }), '2026-10-01')).toBe(false);
  });
  it('lowers the cash and balances the journal', () => {
    const s = settle([line()], terms({ discountPercent: 2, discountDays: 10 }));
    expect(s).toMatchObject({ discountCents: 928, cashCents: 45472, clearedCents: 46400 });
    const j = settlementJournal(s);
    expect(j.filter((x) => x.side === 'debit').reduce((n, x) => n + x.cents, 0)).toBe(j.filter((x) => x.side === 'credit').reduce((n, x) => n + x.cents, 0));
  });
});

describe('tax withheld', () => {
  it('takes the rate of the net share of what is paid, or of the whole', () => {
    // 464.00 paid of an invoice of 400.00 net + 64.00 tax; 5% of the net.
    const net = settle([line()], terms({ withholding: { ratePercent: 5, base: 'net' } }));
    expect(net).toMatchObject({ withholdingBaseCents: 40000, withholdingCents: 2000, cashCents: 44400 });
    const gross = settle([line()], terms({ withholding: { ratePercent: 5, base: 'gross' } }));
    expect(gross).toMatchObject({ withholdingBaseCents: 46400, withholdingCents: 2320, cashCents: 44080 });
  });
  it('follows a part payment by its share of the net', () => {
    const s = settle([line({ grossCents: 23200 })], terms({ withholding: { ratePercent: 5, base: 'net' } }));
    expect(s).toMatchObject({ withholdingBaseCents: 20000, withholdingCents: 1000, cashCents: 22200 });
  });
  it('combines with a discount, and never leaves the cash below zero', () => {
    const s = settle([line()], terms({ discountPercent: 2, discountDays: 10, withholding: { ratePercent: 5, base: 'net' } }));
    expect(s).toMatchObject({ discountCents: 928, withholdingCents: 2000, cashCents: 43472 });
    expect(() => settle([line({ grossCents: 100, invoiceSubtotalCents: 46400 })], terms({ withholding: { ratePercent: 100, base: 'gross' }, discountPercent: 50, discountDays: 30 }))).toThrow(/more than the payment/);
  });
});

describe('tolerance', () => {
  it('closes a small leftover when asked, and refuses a big one', () => {
    const t = terms({ toleranceCents: 100 });
    const s = settle([line({ grossCents: 46350, closeRemainder: true })], t);
    expect(s).toMatchObject({ toleranceCents: 50, clearedCents: 46400, cashCents: 46350 });
    expect(settlementJournal(s).find((x) => x.purpose === 'tolerance')?.cents).toBe(50);
    expect(() => settle([line({ grossCents: 46000, closeRemainder: true })], t)).toThrow(/more than the tolerance/);
    expect(() => settle([line({ closeRemainder: true })], t)).toThrow(/paid in full/);
    expect(() => settle([line({ grossCents: 46350, closeRemainder: true })], terms())).toThrow(/tolerance/);
  });
  it('does not touch an invoice when it is not asked for', () => {
    expect(settle([line({ grossCents: 46350 })], terms({ toleranceCents: 100 })).toleranceCents).toBe(0);
  });
});

describe('several invoices', () => {
  it('totals the lines', () => {
    const s = settle([line({ purchaseInvoiceId: 'a' }), line({ purchaseInvoiceId: 'b', grossCents: 10000, invoiceTotalCents: 10000, invoiceSubtotalCents: 10000, openCents: 10000 })], terms({ withholding: { ratePercent: 10, base: 'net' } }));
    expect(s.grossCents).toBe(56400);
    expect(s.withholdingCents).toBe(4000 + 1000);
    expect(s.cashCents).toBe(56400 - 5000);
  });
});
