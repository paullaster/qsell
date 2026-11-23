import type { PriceTrace } from '@/server/domains/pricing/domain/types';
import { lineDiscount } from '../cash-sales/till-rules';

/** One line of an invoice as a person reads it: what, how many, one unit's price, what a discount took off, the tax rate and the line's total. */
export interface InvoiceLine {
  name: string;
  sku: string | null;
  quantity: number;
  /** The unit the quantity is in ("kg", "box"), when the line was sold in one. */
  unitCode: string | null;
  /** What one unit was charged. */
  unitPrice: number;
  /** What one unit cost before a discount took it down; null when nothing was taken off. */
  listUnitPrice: number | null;
  /** What was taken off the whole line. */
  discount: number;
  /** The tax rate of the product, when the line has one. */
  taxRate: number | null;
  total: number;
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Builds the line from what the order kept. The discount is read the same way the receipt reads it, so an invoice and a receipt never disagree. */
export function invoiceLine(raw: { name: string; sku: string | null; quantity: number; unitCode: string | null; unitPrice: number; total: number; taxRate: number | null; trace: PriceTrace | null }): InvoiceLine {
  const discount = raw.quantity > 0 ? lineDiscount(raw.quantity, raw.total, raw.trace) : 0;
  return {
    name: raw.name,
    sku: raw.sku,
    quantity: raw.quantity,
    unitCode: raw.unitCode,
    unitPrice: raw.unitPrice,
    listUnitPrice: discount > 0 ? cents((raw.total + discount) / raw.quantity) : null,
    discount,
    taxRate: raw.taxRate,
    total: raw.total,
  };
}

/** A line of a part invoice: a description and an amount; the unit price is the amount over the quantity. */
export function partLine(raw: { name: string; quantity: number; amount: number }): InvoiceLine {
  return { name: raw.name, sku: null, quantity: raw.quantity, unitCode: null, unitPrice: raw.quantity > 0 ? cents(raw.amount / raw.quantity) : raw.amount, listUnitPrice: null, discount: 0, taxRate: null, total: raw.amount };
}

/** What is still owed: the invoice less credit notes against it and less what was paid, never below nothing. */
export function balanceOf(total: number, credited: number, paid: number): number {
  return Math.max(0, cents(total - credited - paid));
}
