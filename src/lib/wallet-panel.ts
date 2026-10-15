/**
 * The customer's wallet panel: wording for what moved, which movements may be undone, and the
 * arithmetic of paying invoices from it. Pure. Amounts are handled in whole cents.
 */
import { applications, canApply, fillOldest, type OpenInvoice } from './receipt-detail';

export const ENTRY_TYPE: Record<string, string> = {
  deposit: 'Advance deposit',
  overpayment: 'Overpayment kept',
  utilisation: 'Used on invoices',
  tender: 'Paid an order',
  credit_note: 'Credit note excess kept',
  cash_out: 'Paid out as a refund',
  reversal: 'Put back',
};

export const entryLabel = (type: string): string => (Object.hasOwn(ENTRY_TYPE, type) ? ENTRY_TYPE[type] : type);

export interface WalletEntry {
  id: number;
  type: string;
  sourceType: string | null;
  sourceId: string | null;
}

/** A use of the wallet can be undone once, by someone allowed to, if nothing has already put it back. */
export function canUndoUse(entries: readonly WalletEntry[], entry: WalletEntry, mayReverse: boolean): boolean {
  if (!mayReverse || entry.type !== 'utilisation') return false;
  return !entries.some((x) => x.type === 'reversal' && x.sourceType === 'wallet_entry' && x.sourceId === String(entry.id));
}

export interface WalletInvoice extends OpenInvoice {
  currency: string;
}

/** The open invoices in one currency, in the order they are to be paid. */
export const invoicesIn = <T extends { currency: string }>(invoices: readonly T[], currency: string): T[] => invoices.filter((i) => i.currency === currency);

export const fillFromWallet = (invoices: readonly WalletInvoice[], currency: string, balance: string): Record<string, string> => fillOldest(invoicesIn(invoices, currency), balance);

export { applications as walletApplications, canApply as canPayFromWallet };
