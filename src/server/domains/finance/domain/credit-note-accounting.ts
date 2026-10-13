/**
 * What a credit note does to the books, in whole cents: how much of it is tax, how much the
 * original invoice can still absorb, and how much is left over for someone to decide about.
 */

export class CreditNoteShapeError extends Error {}

/**
 * Splits a credited amount (goods and their tax) the way the sale was split: an order's net is
 * `subtotal` and its tax `tax`, and a credit takes the same share. The tax is what is left, so the
 * two always add up to the credit, to the cent.
 */
export function splitCredit(grossCents: number, orderSubtotalCents: number, orderTaxCents: number): { netCents: number; taxCents: number } {
  if (!(grossCents > 0)) throw new CreditNoteShapeError('A credit note must be for more than zero.');
  const goods = orderSubtotalCents + orderTaxCents;
  if (orderTaxCents <= 0 || goods <= 0) return { netCents: grossCents, taxCents: 0 };
  const netCents = Math.round((grossCents * orderSubtotalCents) / goods);
  return { netCents, taxCents: grossCents - netCents };
}

/** The invoice takes what it still owes; whatever is beyond that is the customer's to be given back. */
export function planCredit(invoiceOpenCents: number, grossCents: number): { appliedCents: number; excessCents: number } {
  const appliedCents = Math.max(0, Math.min(invoiceOpenCents, grossCents));
  return { appliedCents, excessCents: grossCents - appliedCents };
}

export interface CreditNoteLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  description: string;
}

/** Dr sales returns and tax owed, Cr trade debtors. Zero lines are left out. */
export function creditNoteLines(
  split: { netCents: number; taxCents: number },
  accounts: { salesReturns: string; outputTax: string | null; receivables: string },
  label: string,
): CreditNoteLine[] {
  const gross = split.netCents + split.taxCents;
  const lines: CreditNoteLine[] = [];
  if (split.netCents > 0) lines.push({ accountId: accounts.salesReturns, debitCents: split.netCents, creditCents: 0, description: `Returns ${label}` });
  if (split.taxCents > 0) {
    if (!accounts.outputTax) throw new CreditNoteShapeError('Tax was charged on the sale but no account is set for tax owed on sales.');
    lines.push({ accountId: accounts.outputTax, debitCents: split.taxCents, creditCents: 0, description: `Tax on ${label}` });
  }
  lines.push({ accountId: accounts.receivables, debitCents: 0, creditCents: gross, description: `Credit note ${label}` });
  return lines;
}

export type ReturnCondition = 'good' | 'damaged' | 'expired' | 'wrong_item';
export type ReturnDisposition = 'return_to_stock' | 'quarantine' | 'scrap' | 'return_to_supplier';

/** Only goods in good condition go back on the shelf; anything else must be put somewhere else. */
export function checkDisposition(condition: ReturnCondition, disposition: ReturnDisposition): string | null {
  if (disposition === 'return_to_stock' && condition !== 'good') {
    return 'Only goods in good condition can go back into stock. Choose quarantine, scrap or return to supplier.';
  }
  return null;
}

/** What to suggest when the goods arrive, from why the credit note was raised. */
export function suggestedDisposition(reasonCode: string): ReturnDisposition {
  return reasonCode === 'damaged_goods' ? 'scrap' : 'return_to_stock';
}
