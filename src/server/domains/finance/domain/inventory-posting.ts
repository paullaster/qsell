/**
 * Which accounts a change in the value of stock moves between. Pure: data in, a plan out. Money is in whole cents.
 *
 * Stock is carried in the books at cost. Goods in from a supplier build it up against "stock received, not yet
 * invoiced"; goods sold draw it down into cost of sales; goods that come back from a customer undo that; counts,
 * write-offs and changes of cost go through the adjustment account, so every difference stays visible.
 */
export type Side = 'inventory' | 'cogs' | 'inventory_adjustment' | 'inventory_clearing';

export interface InventoryChange {
  kind: 'movement' | 'revaluation';
  changeType: string;
  /** Signed value of the change: units × cost per unit, in cents. */
  valueCents: number;
}

export interface Plan {
  debit: Side;
  credit: Side;
  cents: number;
  /** A word for the posting's description. */
  label: string;
}

const RECEIPTS = new Set(['purchase_order_receipt', 'restock', 'product_restored']);
const LABELS: Record<string, string> = {
  purchase_order_receipt: 'Stock received',
  restock: 'Stock received',
  product_restored: 'Product restored',
  credit_note_restock: 'Goods back from a customer',
  purchase_receipt_reversal: 'Goods receipt reversed',
  purchase_return: 'Goods returned to the vendor',
  order_fulfillment: 'Goods sold',
  damage_writeoff: 'Stock written off',
  manual_adjustment: 'Stock adjusted',
  physical_audit: 'Stock count',
  product_deleted: 'Product removed',
  cost_change: 'Cost changed',
};

export const changeLabel = (changeType: string): string => (Object.hasOwn(LABELS, changeType) ? LABELS[changeType] : 'Stock changed');

/** The accounts a change moves value between, or null when there is nothing to post (no value). */
export function planChange(c: InventoryChange): Plan | null {
  if (c.valueCents === 0) return null;
  const cents = Math.abs(c.valueCents);
  const label = changeLabel(c.changeType);
  if (c.kind === 'revaluation') {
    return c.valueCents > 0 ? { debit: 'inventory', credit: 'inventory_adjustment', cents, label } : { debit: 'inventory_adjustment', credit: 'inventory', cents, label };
  }
  if (c.valueCents > 0) {
    if (RECEIPTS.has(c.changeType)) return { debit: 'inventory', credit: 'inventory_clearing', cents, label };
    if (c.changeType === 'credit_note_restock') return { debit: 'inventory', credit: 'cogs', cents, label };
    return { debit: 'inventory', credit: 'inventory_adjustment', cents, label };
  }
  if (c.changeType === 'order_fulfillment') return { debit: 'cogs', credit: 'inventory', cents, label };
  // Undoing a receipt undoes what it posted: the stock leaves and the clearing account is cleared of it again.
  if (c.changeType === 'purchase_receipt_reversal' || c.changeType === 'purchase_return') return { debit: 'inventory_clearing', credit: 'inventory', cents, label };
  return { debit: 'inventory_adjustment', credit: 'inventory', cents, label };
}

/** The value of goods: units × cost per unit, in whole cents (units have up to three decimals, so a half cent rounds away from zero). */
export function stockValueCents(quantity: number, unitCost: string): number {
  const [whole = '0', frac = ''] = unitCost.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
  const value = quantity * (unitCost.startsWith('-') ? -cents : cents);
  return Math.sign(value) * Math.round(Math.abs(value) + 1e-9);
}

export interface InventoryReadinessInput {
  financeSetUp: boolean;
  missing: readonly string[];
  live: boolean;
  failed: number;
}

export interface Check {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
}

const PURPOSE_NAMES: Record<string, string> = {
  inventory: 'Inventory (stock at cost)',
  cogs: 'Cost of sales',
  inventory_adjustment: 'Inventory adjustments',
  inventory_clearing: 'Stock received, not yet invoiced',
};

export const purposeName = (purpose: string): string => (Object.hasOwn(PURPOSE_NAMES, purpose) ? PURPOSE_NAMES[purpose] : purpose);

/** What must be true before stock can reach the books, and what is worth knowing once it does. */
export function readinessChecks(i: InventoryReadinessInput): Check[] {
  const out: Check[] = [
    { key: 'finance', label: 'Finance is set up', ok: i.financeSetUp, detail: i.financeSetUp ? 'The chart of accounts is in place.' : 'Choose a chart of accounts first (Finance → Chart of accounts).', blocking: true },
  ];
  for (const purpose of ['inventory', 'cogs', 'inventory_adjustment', 'inventory_clearing']) {
    const missing = i.missing.includes(purpose);
    out.push({ key: purpose, label: `${purposeName(purpose)} has an account`, ok: !missing, detail: missing ? 'Choose it under Finance → Posting setup.' : 'Set.', blocking: true });
  }
  out.push({ key: 'live', label: 'Stock is posting to the books', ok: i.live, detail: i.live ? 'Every change in stock reaches the ledger within a minute.' : 'Not switched on yet.', blocking: false });
  out.push({ key: 'failed', label: 'Nothing is waiting to be fixed', ok: i.failed === 0, detail: i.failed === 0 ? 'Every change has been posted.' : `${String(i.failed)} change${i.failed === 1 ? '' : 's'} could not be posted yet; they are retried until the setup is right.`, blocking: false });
  return out;
}
