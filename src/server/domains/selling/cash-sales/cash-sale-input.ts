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
  return { ok: true, customerId: customerId === '' ? null : customerId, lines: lines.input.lines };
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
