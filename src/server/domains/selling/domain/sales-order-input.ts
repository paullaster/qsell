import type { StoredPick } from '@/server/domains/pricing/domain/package-shop';
import { isCalendarDay } from '@/server/domains/pricing/domain/package-quote-input';

/** What staff send to place a sales order: ids, counts and choices only. Prices, credit and flags are never taken from here. */
export interface SalesOrderLineInput {
  productId: string;
  /** Units of the product, or servings of a package. */
  quantity: number;
  /** A package line: what was chosen, by the slot's name and the part (as a quote keeps it), and the note on each serving. */
  package?: { picks: StoredPick[]; note: string };
}

/** How the customer is expected to pay (a label for the order: money is received by receipt). "On account" belongs to Credit Sales; the customer's credit comes from their account. */
export const SALES_ORDER_PAYMENT_METHODS = ['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni'] as const;
export type SalesOrderPaymentMethod = (typeof SALES_ORDER_PAYMENT_METHODS)[number];

export interface SalesOrderInput {
  customerId: string;
  lines: SalesOrderLineInput[];
  paymentMethod: SalesOrderPaymentMethod;
  /** The day it is needed (`YYYY-MM-DD`), or empty. */
  neededOn: string;
  holdUntilPaid: boolean;
}

export const SALES_ORDER_LIMITS = { lines: 100, quantity: 1_000_000, picks: 200 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function readPicks(raw: unknown): StoredPick[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SALES_ORDER_LIMITS.picks) return null;
  const picks: StoredPick[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const count = entry.count;
    const slotName = text(entry.slotName, 80);
    const productId = text(entry.productId, 100);
    if (slotName === '' || productId === '' || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1000) return null;
    picks.push({ slotName, productId, name: text(entry.name, 120), count });
  }
  return picks;
}

export type ParsedSalesOrder = { ok: true; input: SalesOrderInput } | { ok: false; error: string };

/** Reads what the screen sent (untrusted). Everything is bounded; whether the choices are real is decided on the server. */
export function parseSalesOrderInput(raw: unknown): ParsedSalesOrder {
  if (!isRecord(raw)) return { ok: false, error: 'The order could not be read.' };
  const customerId = text(raw.customerId, 40);
  if (!UUID.test(customerId)) return { ok: false, error: 'Choose the customer.' };
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) return { ok: false, error: 'Add something to sell.' };
  if (raw.lines.length > SALES_ORDER_LIMITS.lines) return { ok: false, error: `An order can have at most ${String(SALES_ORDER_LIMITS.lines)} lines.` };
  const lines: SalesOrderLineInput[] = [];
  for (const [n, entry] of raw.lines.entries()) {
    if (!isRecord(entry)) return { ok: false, error: `Line ${String(n + 1)} could not be read.` };
    const productId = text(entry.productId, 100);
    const quantity = entry.quantity;
    if (productId === '') return { ok: false, error: `Line ${String(n + 1)}: choose a product.` };
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > SALES_ORDER_LIMITS.quantity) return { ok: false, error: `Line ${String(n + 1)}: the quantity must be more than nothing.` };
    if (entry.package === undefined || entry.package === null) {
      lines.push({ productId, quantity });
      continue;
    }
    if (!isRecord(entry.package)) return { ok: false, error: `Line ${String(n + 1)}: the package choices could not be read.` };
    const picks = readPicks(entry.package.picks);
    if (picks === null) return { ok: false, error: `Line ${String(n + 1)}: the package choices could not be read.` };
    if (!Number.isInteger(quantity)) return { ok: false, error: `Line ${String(n + 1)}: a package is sold in whole servings.` };
    lines.push({ productId, quantity, package: { picks, note: text(entry.package.note, 200) } });
  }
  const paymentMethod = raw.paymentMethod === undefined || raw.paymentMethod === '' ? 'mpesa_daraja' : SALES_ORDER_PAYMENT_METHODS.find((m) => m === raw.paymentMethod);
  if (paymentMethod === undefined) return { ok: false, error: 'Choose how the customer will pay.' };
  const neededOn = text(raw.neededOn, 10);
  if (neededOn !== '' && !isCalendarDay(neededOn)) return { ok: false, error: 'That is not a date.' };
  return { ok: true, input: { customerId, lines, paymentMethod, neededOn, holdUntilPaid: raw.holdUntilPaid === true } };
}
