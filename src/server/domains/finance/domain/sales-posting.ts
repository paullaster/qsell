import { fromCents } from './receivables';

/** An order's money, in whole cents. Goods + tax + shipping = total, always. */
export interface SaleFigures {
  totalCents: number;
  taxCents: number;
  shippingCents: number;
}

export class SaleShapeError extends Error {}

/** What the sale earns: the total less tax and shipping (so the entry balances to the cent). */
export function splitSale(f: SaleFigures): { salesCents: number; taxCents: number; shippingCents: number } {
  const salesCents = f.totalCents - f.taxCents - f.shippingCents;
  if (f.totalCents <= 0) throw new SaleShapeError('A sale with no value has nothing to post.');
  if (f.taxCents < 0 || f.shippingCents < 0 || salesCents < 0) {
    throw new SaleShapeError('The order\'s tax and shipping are larger than its total.');
  }
  return { salesCents, taxCents: f.taxCents, shippingCents: f.shippingCents };
}

export interface PlannedLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  description: string;
  sourceLedger?: string;
  sourceEntryId?: string;
}

export interface SaleAccounts {
  sales: string;
  /** Needed only when tax was charged. */
  outputTax: string | null;
  /** Needed only when shipping was charged. */
  serviceCharge: string | null;
}

/** The credit side of a sale: income, tax owed, shipping income. Zero amounts are left out. */
export function saleCredits(f: SaleFigures, a: SaleAccounts, label: string): PlannedLine[] {
  const { salesCents, taxCents, shippingCents } = splitSale(f);
  const lines: PlannedLine[] = [];
  if (salesCents > 0) lines.push({ accountId: a.sales, debitCents: 0, creditCents: salesCents, description: `Sales ${label}` });
  if (taxCents > 0) {
    if (!a.outputTax) throw new SaleShapeError('Tax was charged but no account is set for tax owed on sales.');
    lines.push({ accountId: a.outputTax, debitCents: 0, creditCents: taxCents, description: `Tax on ${label}` });
  }
  if (shippingCents > 0) {
    if (!a.serviceCharge) throw new SaleShapeError('Shipping was charged but the customer posting group has no service-charge account.');
    lines.push({ accountId: a.serviceCharge, debitCents: 0, creditCents: shippingCents, description: `Shipping on ${label}` });
  }
  return lines;
}

/** Credit invoice: the customer owes the whole total. */
export function creditInvoiceLines(f: SaleFigures, a: SaleAccounts & { receivables: string }, label: string): PlannedLine[] {
  return [{ accountId: a.receivables, debitCents: f.totalCents, creditCents: 0, description: `Invoice ${label}` }, ...saleCredits(f, a, label)];
}

export interface Settlement {
  accountId: string;
  cents: number;
  description: string;
}

/**
 * Cash sale: paid at the sale, so no debtor. The debit side is however it was settled (the bank
 * account of the payment method, a gift-card liability, loyalty points); it must add up to the total.
 */
export function cashSaleLines(f: SaleFigures, a: SaleAccounts, settled: Settlement[], label: string): PlannedLine[] {
  const paid = settled.filter((s) => s.cents > 0);
  const sum = paid.reduce((n, s) => n + s.cents, 0);
  if (sum !== f.totalCents) {
    throw new SaleShapeError(`The sale is ${fromCents(f.totalCents)} but what paid for it adds up to ${fromCents(sum)}.`);
  }
  return [
    ...paid.map((s) => ({ accountId: s.accountId, debitCents: s.cents, creditCents: 0, description: s.description })),
    ...saleCredits(f, a, label),
  ];
}

/** A rebate credited to a customer: the cost, against what they owe. */
export function rebateLines(cents: number, expenseAccount: string, receivables: string, label: string): PlannedLine[] {
  if (cents <= 0) throw new SaleShapeError('A rebate must be more than zero.');
  return [
    { accountId: expenseAccount, debitCents: cents, creditCents: 0, description: `Rebate ${label}` },
    { accountId: receivables, debitCents: 0, creditCents: cents, description: `Rebate ${label}` },
  ];
}

export const toAmount = fromCents;
