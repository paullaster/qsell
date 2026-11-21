import { parseSalesOrderInput, type SalesOrderLineInput } from '../domain/sales-order-input';
import { MAX_TENDERS } from './tender-rules';

export interface ParsedCashSale {
  customerId: string | null;
  lines: SalesOrderLineInput[];
  tenders: { methodId: string; amount: number; reference: string }[];
  saleKey: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Reads the lines of a sale being priced (no payment yet). Ids, counts and choices only; the server prices them. */
export function parseCashSaleLines(raw: unknown): { ok: true; customerId: string | null; lines: SalesOrderLineInput[] } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'The sale could not be read.' };
  const customerId = text(raw.customerId, 40);
  if (customerId !== '' && !UUID.test(customerId)) return { ok: false, error: 'That customer could not be read.' };
  // The lines are read by the same rules as every selling document; the customer is checked here, so a placeholder stands in for it.
  const lines = parseSalesOrderInput({ lines: raw.lines, customerId: '00000000-0000-4000-8000-000000000000' });
  if (!lines.ok) return lines;
  // A price typed at the till is read here and nowhere else; the lines come back in the order they were sent, so each is matched by its place.
  const sent = Array.isArray(raw.lines) ? (raw.lines as unknown[]) : [];
  const priced: SalesOrderLineInput[] = [];
  for (const [n, line] of lines.input.lines.entries()) {
    const typed = isRecord(sent[n]) ? sent[n].unitPrice : undefined;
    if (typed === undefined || typed === null) {
      priced.push(line);
      continue;
    }
    if (typeof typed !== 'number' || !Number.isFinite(typed) || typed <= 0 || typed > 100_000_000) return { ok: false, error: `Line ${String(n + 1)}: the price must be more than nothing.` };
    priced.push(line.package === undefined ? { ...line, unitPrice: Math.round(typed * 100) / 100 } : line);
  }
  return { ok: true, customerId: customerId === '' ? null : customerId, lines: priced };
}

/** Reads what the till screen sent for a sale (untrusted): the lines, how it was paid, the customer if one was chosen, and the key of this attempt. */
export function parseCashSale(raw: unknown): { ok: true; sale: ParsedCashSale } | { ok: false; error: string } {
  const read = parseCashSaleLines(raw);
  if (!read.ok) return read;
  if (!isRecord(raw)) return { ok: false, error: 'The sale could not be read.' };
  const saleKey = text(raw.saleKey, 40);
  if (!UUID.test(saleKey)) return { ok: false, error: 'This sale could not be told apart from another. Start the sale again.' };
  if (!Array.isArray(raw.tenders) || raw.tenders.length === 0) return { ok: false, error: 'Choose how the customer pays.' };
  if (raw.tenders.length > MAX_TENDERS) return { ok: false, error: `A sale can be paid in at most ${String(MAX_TENDERS)} ways.` };
  const tenders: ParsedCashSale['tenders'] = [];
  for (const [n, entry] of raw.tenders.entries()) {
    if (!isRecord(entry)) return { ok: false, error: `Payment ${String(n + 1)} could not be read.` };
    const methodId = text(entry.methodId, 40);
    const amount = entry.amount;
    if (!UUID.test(methodId)) return { ok: false, error: `Payment ${String(n + 1)}: choose how it is paid.` };
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) return { ok: false, error: `Payment ${String(n + 1)}: give an amount of more than nothing.` };
    tenders.push({ methodId, amount, reference: text(entry.reference, 60) });
  }
  return { ok: true, sale: { customerId: read.customerId, lines: read.lines, tenders, saleKey } };
}

export interface ParsedCounterReturn {
  orderId: string;
  lines: { productId: string; quantity: number }[];
  reason: { code: string; text: string };
  restock: boolean;
  refund: { methodId: string; phone: string; recipient: string };
  key: string;
}

/** Reads what the till screen sent for a return (untrusted): the sale, the lines and counts, why, whether the goods go back into stock, how the customer is paid back, and the key of this attempt. */
export function parseCounterReturn(raw: unknown): { ok: true; input: ParsedCounterReturn } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'The return could not be read.' };
  const orderId = text(raw.orderId, 100);
  const key = text(raw.key, 40);
  if (orderId === '') return { ok: false, error: 'Choose the sale.' };
  if (!UUID.test(key)) return { ok: false, error: 'This return could not be told apart from another. Start it again.' };
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) return { ok: false, error: 'Choose what is being returned.' };
  if (raw.lines.length > 100) return { ok: false, error: 'Too many lines.' };
  const lines: ParsedCounterReturn['lines'] = [];
  for (const [n, entry] of raw.lines.entries()) {
    if (!isRecord(entry)) return { ok: false, error: `Line ${String(n + 1)} could not be read.` };
    const productId = text(entry.productId, 100);
    const quantity = entry.quantity;
    if (productId === '' || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) return { ok: false, error: `Line ${String(n + 1)}: give the quantity returned.` };
    if (lines.some((l) => l.productId === productId)) return { ok: false, error: 'Each product can be on the return once.' };
    lines.push({ productId, quantity });
  }
  const reason = isRecord(raw.reason) ? raw.reason : {};
  const refund = isRecord(raw.refund) ? raw.refund : {};
  const methodId = text(refund.methodId, 40);
  if (!UUID.test(methodId)) return { ok: false, error: 'Choose how the customer is paid back.' };
  return { ok: true, input: { orderId, lines, reason: { code: text(reason.code, 60), text: text(reason.text, 200) }, restock: raw.restock === true, refund: { methodId, phone: text(refund.phone, 20), recipient: text(refund.recipient, 80) }, key } };
}
