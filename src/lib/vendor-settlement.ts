/**
 * What a payment to a vendor really does, worked out in whole cents from plain data (design doc §12.5): how much of each invoice it
 * clears, the early-payment discount taken, a small leftover closed as tolerance, the tax withheld and the cash that goes out. One
 * pure function, so the voucher, the bank file and the journal always agree.
 *
 * For a line that clears `gross` of an invoice: the vendor forgives `discount` of it, we withhold `withholding` of what we pay, and
 * `cash` = gross - discount - withholding leaves the bank. If the invoice is then left with a little open (no more than the
 * tolerance) and the person asked for it, that leftover is `tolerance`, closed without a payment.
 *   Dr payables (gross + tolerance) = Cr cash + Cr withholding payable + Cr discount received + Cr tolerance
 */
export type WithholdingBase = 'net' | 'gross';

export interface SettlementLineInput {
  purchaseInvoiceId: string;
  /** How much of the invoice this voucher clears, in cents. */
  grossCents: number;
  invoiceDate: string;
  invoiceTotalCents: number;
  invoiceSubtotalCents: number;
  /** What is open on the invoice now, in cents. */
  openCents: number;
  /** Close what is left after this payment as tolerance, when it is small enough. */
  closeRemainder: boolean;
}

export interface SettlementTerms {
  /** Early-payment discount: this percent if paid within this many days of the invoice date. 0 turns it off. */
  discountPercent: number;
  discountDays: number;
  /** The code of the vendor, when tax is withheld from it. */
  withholding: { ratePercent: number; base: WithholdingBase } | null;
  /** The largest leftover that may be closed as tolerance, in cents. 0 turns it off. */
  toleranceCents: number;
  /** The day the terms are judged on (the approval date). */
  asOf: string;
}

export interface SettledLine {
  purchaseInvoiceId: string;
  grossCents: number;
  discountCents: number;
  toleranceCents: number;
  withholdingCents: number;
  withholdingBaseCents: number;
  cashCents: number;
}

export interface Settlement {
  lines: SettledLine[];
  grossCents: number;
  discountCents: number;
  toleranceCents: number;
  withholdingCents: number;
  withholdingBaseCents: number;
  cashCents: number;
  /** The invoice balance cleared in all: gross plus tolerance. */
  clearedCents: number;
}

export class SettlementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const DAY = 86_400_000;
const days = (from: string, to: string): number => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Is the discount still on offer on `asOf` for an invoice dated `invoiceDate`? */
export const discountOpen = (t: Pick<SettlementTerms, 'discountPercent' | 'discountDays' | 'asOf'>, invoiceDate: string): boolean =>
  t.discountPercent > 0 && t.discountDays > 0 && days(invoiceDate, t.asOf) <= t.discountDays;

export function settle(inputs: readonly SettlementLineInput[], terms: SettlementTerms): Settlement {
  const lines: SettledLine[] = [];
  for (const l of inputs) {
    if (!Number.isInteger(l.grossCents) || l.grossCents <= 0) throw new SettlementError('AMOUNT', 'Each amount to pay must be above zero.');
    if (l.grossCents > l.openCents) throw new SettlementError('TOO_MUCH', 'An amount is more than is open on its invoice.');
    const discountCents = discountOpen(terms, l.invoiceDate) ? Math.round((l.grossCents * terms.discountPercent) / 100) : 0;
    let toleranceCents = 0;
    if (l.closeRemainder) {
      const left = l.openCents - l.grossCents;
      if (left <= 0) throw new SettlementError('NOTHING_LEFT', 'There is no leftover to close on an invoice that is paid in full.');
      if (terms.toleranceCents <= 0 || left > terms.toleranceCents) throw new SettlementError('TOLERANCE', `What is left (${(left / 100).toFixed(2)}) is more than the tolerance allows (${(terms.toleranceCents / 100).toFixed(2)}).`);
      toleranceCents = left;
    }
    let withholdingBaseCents = 0;
    let withholdingCents = 0;
    if (terms.withholding !== null && l.invoiceTotalCents > 0) {
      withholdingBaseCents = terms.withholding.base === 'net' ? Math.round((l.grossCents * l.invoiceSubtotalCents) / l.invoiceTotalCents) : l.grossCents;
      withholdingCents = Math.round((withholdingBaseCents * terms.withholding.ratePercent) / 100);
    }
    const cashCents = l.grossCents - discountCents - withholdingCents;
    if (cashCents < 0) throw new SettlementError('NEGATIVE_CASH', 'The discount and the tax withheld are more than the payment.');
    lines.push({ purchaseInvoiceId: l.purchaseInvoiceId, grossCents: l.grossCents, discountCents, toleranceCents, withholdingCents, withholdingBaseCents, cashCents });
  }
  const sum = (pick: (l: SettledLine) => number): number => lines.reduce((n, l) => n + pick(l), 0);
  const grossCents = sum((l) => l.grossCents);
  const toleranceCents = sum((l) => l.toleranceCents);
  return {
    lines,
    grossCents,
    discountCents: sum((l) => l.discountCents),
    toleranceCents,
    withholdingCents: sum((l) => l.withholdingCents),
    withholdingBaseCents: sum((l) => l.withholdingBaseCents),
    cashCents: sum((l) => l.cashCents),
    clearedCents: grossCents + toleranceCents,
  };
}

export interface JournalPlanLine {
  side: 'debit' | 'credit';
  purpose: 'payables' | 'cash' | 'withholding' | 'discount' | 'tolerance';
  cents: number;
}

/** The journal of a settled payment. Always balances; a purpose with nothing to book is left out. */
export function settlementJournal(s: Settlement): JournalPlanLine[] {
  const lines: JournalPlanLine[] = [
    { side: 'debit', purpose: 'payables', cents: s.clearedCents },
    { side: 'credit', purpose: 'cash', cents: s.cashCents },
    { side: 'credit', purpose: 'withholding', cents: s.withholdingCents },
    { side: 'credit', purpose: 'discount', cents: s.discountCents },
    { side: 'credit', purpose: 'tolerance', cents: s.toleranceCents },
  ];
  return lines.filter((l) => l.cents > 0);
}
