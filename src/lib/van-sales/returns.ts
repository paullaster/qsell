/**
 * Returns at a visit: goods a customer gives back to the rep from an earlier cash sale made from the same van (docs/architecture/van-sales.md §7).
 * Reading what the rep sends, and when a return can be taken. Pure.
 */
import { isRecord } from '@/lib/values';
import { isId } from './people';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_RETURN_LINES = 100;

export interface ReturnInput {
  visitId: string;
  orderId: string;
  lines: { productId: string; quantity: number }[];
  reason: { code: string; text: string };
  /** The goods are fit to be sold again and go back on the van; otherwise they are not counted back into stock. */
  restock: boolean;
  refund: { methodId: string; phone: string };
  /** One key for one return: a repeat finds the return and finishes what is left. */
  key: string;
}

const clean = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

/** Reads a return as the rep typed it. */
export function readVanReturn(raw: unknown): { ok: true; ret: ReturnInput } | { ok: false; error: string } {
  const r = isRecord(raw) ? raw : {};
  if (!isId(r.visitId)) return { ok: false, error: 'Choose the visit the goods are returned at.' };
  const orderId = clean(r.orderId, 100);
  if (orderId === '') return { ok: false, error: 'Choose the sale the goods were bought on.' };
  if (typeof r.key !== 'string' || !UUID.test(r.key)) return { ok: false, error: 'This return could not be told apart from another. Start it again.' };
  if (!Array.isArray(r.lines) || r.lines.length === 0) return { ok: false, error: 'Say what is being returned.' };
  if (r.lines.length > MAX_RETURN_LINES) return { ok: false, error: `A return can have at most ${String(MAX_RETURN_LINES)} lines.` };
  const lines: ReturnInput['lines'] = [];
  for (const [n, entry] of r.lines.entries()) {
    const e = isRecord(entry) ? entry : {};
    const productId = clean(e.productId, 100);
    const quantity = e.quantity;
    if (productId === '' || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) return { ok: false, error: `Line ${String(n + 1)}: give the quantity returned.` };
    if (lines.some((l) => l.productId === productId)) return { ok: false, error: 'Each product can be on the return once.' };
    lines.push({ productId, quantity });
  }
  const reason = isRecord(r.reason) ? r.reason : {};
  const code = clean(reason.code, 60);
  if (code === '') return { ok: false, error: 'Say why the goods are returned.' };
  const refund = isRecord(r.refund) ? r.refund : {};
  if (typeof refund.methodId !== 'string' || !UUID.test(refund.methodId)) return { ok: false, error: 'Choose how the customer is paid back.' };
  return { ok: true, ret: { visitId: r.visitId, orderId, lines, reason: { code, text: clean(reason.text, 200) }, restock: r.restock === true, refund: { methodId: refund.methodId, phone: clean(refund.phone, 20) }, key: r.key } };
}

/** Why a return cannot be taken now, or null: the day is out, the rep is at the customer, and the sale is the customer's own. */
export function returnProblem(f: { dayStatus: string; visitStatus: string; customerName: string; saleIsCustomers: boolean; saleOnThisVan: boolean }): string | null {
  if (f.dayStatus !== 'out') return 'Returns are taken while the day is out on the route.';
  if (f.visitStatus !== 'arrived') return `Arrive at ${f.customerName} before taking goods back from them.`;
  if (!f.saleIsCustomers) return `That sale was not made to ${f.customerName}.`;
  if (!f.saleOnThisVan) return 'That sale was not made from this van, so the goods cannot go back on it.';
  return null;
}
