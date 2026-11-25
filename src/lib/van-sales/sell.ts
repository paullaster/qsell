/**
 * Selling from the van (docs/architecture/van-sales.md §3, §8): reading what the rep sends for a sale and holding it to what the rep may do on
 * their own. Prices, totals, stock and the customer's credit are always the server's; nothing here trusts a figure from the phone. Pure.
 */
import { MAX_QUANTITY } from '@/lib/decimal';
import { isRecord } from '@/lib/values';
import { creditProblem, discountProblem, priceProblem, type RepLimits } from './rep-limits';
import { isId } from './people';

export const SALE_KINDS = ['cash', 'credit'] as const;
export type SaleKind = (typeof SALE_KINDS)[number];
export const SALE_KIND_WORDS: Record<SaleKind, string> = { cash: 'Paid now', credit: 'On the customer\'s account' };

export const MAX_SALE_LINES = 100;
export const MAX_TENDERS = 4;

export interface SaleLine {
  productId: string;
  quantity: number;
  /** A price the rep typed for one unit: honoured only where the rep may change prices. */
  unitPrice?: number;
  /** A discount the rep gave: a percentage, within their limit. */
  discount?: { kind: 'percent'; value: number };
}

export interface SaleTender {
  methodId: string;
  amount: number;
  reference: string;
}

export interface SaleInput {
  visitId: string;
  kind: SaleKind;
  lines: SaleLine[];
  /** How a sale paid now is paid; none for a sale on account. */
  tenders: SaleTender[];
  /** One key for one attempt at one sale: a retry finds the sale it made. */
  saleKey: string;
}

export type SaleRead = { ok: true; sale: SaleInput } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (n: number): number => Math.round(n * 100) / 100;

export function readSaleLines(raw: unknown): { ok: true; lines: SaleLine[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Add something to sell.' };
  if (raw.length > MAX_SALE_LINES) return { ok: false, error: `A sale can have at most ${String(MAX_SALE_LINES)} lines.` };
  const lines: SaleLine[] = [];
  for (const [n, entry] of (raw as unknown[]).entries()) {
    const x = isRecord(entry) ? entry : {};
    const where = `Line ${String(n + 1)}`;
    if (typeof x.productId !== 'string' || x.productId === '' || x.productId.length > 100) return { ok: false, error: `${where}: choose a product.` };
    const quantity = typeof x.quantity === 'number' ? x.quantity : Number(x.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) return { ok: false, error: `${where}: the quantity must be more than nothing.` };
    const line: SaleLine = { productId: x.productId, quantity };
    if (x.unitPrice !== undefined && x.unitPrice !== null && x.unitPrice !== '') {
      const price = typeof x.unitPrice === 'number' ? x.unitPrice : Number(x.unitPrice);
      if (!Number.isFinite(price) || price <= 0) return { ok: false, error: `${where}: the price must be more than nothing.` };
      line.unitPrice = money(price);
    }
    if (x.discount !== undefined && x.discount !== null) {
      const d = isRecord(x.discount) ? x.discount : {};
      if (d.kind !== 'percent') return { ok: false, error: `${where}: a discount on a van sale is a percentage.` };
      const value = typeof d.value === 'number' ? d.value : Number(d.value);
      if (!Number.isFinite(value) || value <= 0 || value >= 100) return { ok: false, error: `${where}: a discount is a percentage between 0 and 100.` };
      line.discount = { kind: 'percent', value: money(value) };
    }
    lines.push(line);
  }
  return { ok: true, lines };
}

function readTenders(raw: unknown): { ok: true; tenders: SaleTender[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Choose how the customer pays.' };
  if (raw.length > MAX_TENDERS) return { ok: false, error: `A sale can be paid in at most ${String(MAX_TENDERS)} ways.` };
  const tenders: SaleTender[] = [];
  for (const entry of raw as unknown[]) {
    const x = isRecord(entry) ? entry : {};
    if (!isId(x.methodId)) return { ok: false, error: 'Choose how the customer pays from the list.' };
    const amount = typeof x.amount === 'number' ? x.amount : Number(x.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Each payment must be more than nothing.' };
    const reference = typeof x.reference === 'string' ? x.reference.trim().slice(0, 60) : '';
    tenders.push({ methodId: x.methodId, amount: money(amount), reference });
  }
  return { ok: true, tenders };
}

/** Reads a sale as the rep's phone sent it. */
export function readSale(raw: unknown): SaleRead {
  if (!isRecord(raw)) return { ok: false, error: 'The sale could not be read.' };
  if (!isId(raw.visitId)) return { ok: false, error: 'Choose the visit the sale is made at.' };
  const kind = SALE_KINDS.find((k) => k === raw.kind);
  if (kind === undefined) return { ok: false, error: 'Say whether the sale is paid now or on the customer\'s account.' };
  if (typeof raw.saleKey !== 'string' || !UUID.test(raw.saleKey)) return { ok: false, error: 'This sale could not be told apart from another. Start the sale again.' };
  const lines = readSaleLines(raw.lines);
  if (!lines.ok) return lines;
  let tenders: SaleTender[] = [];
  if (kind === 'cash') {
    const read = readTenders(raw.tenders);
    if (!read.ok) return read;
    tenders = read.tenders;
  }
  return { ok: true, sale: { visitId: raw.visitId, kind, lines: lines.lines, tenders, saleKey: raw.saleKey } };
}

/**
 * Holds a sale to what the rep may do on their own, before any price is worked out: a price they typed needs the right to change prices, a
 * discount must be within their limit, and a sale on account needs the right to give credit. The amount of credit is checked once the
 * server has priced the sale (`creditAmountProblem`). Null when the sale is allowed.
 */
export function repSaleProblem(limits: RepLimits, sale: Pick<SaleInput, 'kind' | 'lines'>): string | null {
  if (sale.lines.some((l) => l.unitPrice !== undefined)) {
    const price = priceProblem(limits);
    if (price !== null) return price;
  }
  for (const l of sale.lines) {
    if (l.discount === undefined) continue;
    const problem = discountProblem(limits, l.discount.value);
    if (problem !== null) return problem;
  }
  if (sale.kind === 'credit' && !limits.maySellOnCredit) return 'You are not allowed to sell on credit.';
  return null;
}

/** Whether the priced total of a sale on account is within what the rep may give in a day. */
export const creditAmountProblem = (limits: RepLimits, total: number, givenToday: number): string | null => creditProblem(limits, total, givenToday);

// ── The sale being made on the phone ──────────────────────────────────────────────────────────────────────────

/** A line as the rep has typed it: text boxes, not yet numbers. */
export interface TypedLine {
  productId: string;
  name: string;
  quantity: string;
  /** A percentage, as typed; empty for none. */
  discount: string;
  /** A price for one, as typed; empty to use the server's price. */
  price: string;
}

/** A way of paying as the rep has typed it. */
export interface TypedTender {
  methodId: string;
  amount: string;
  reference: string;
}

const num = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));

/** The lines to send: only those with a quantity, with a discount and a price only where they were typed. */
export function saleLinesOf(rows: readonly TypedLine[]): SaleLine[] {
  return rows.flatMap((r) => {
    const quantity = num(r.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return [];
    const discount = num(r.discount);
    const price = num(r.price);
    return [{ productId: r.productId, quantity, ...(Number.isFinite(price) && price > 0 ? { unitPrice: price } : {}), ...(Number.isFinite(discount) && discount > 0 ? { discount: { kind: 'percent' as const, value: discount } } : {}) }];
  });
}

/** The payments to send: only those with an amount. */
export const tendersOf = (rows: readonly TypedTender[]): SaleTender[] =>
  rows.flatMap((r) => {
    const amount = num(r.amount);
    return Number.isFinite(amount) && amount > 0 && r.methodId !== '' ? [{ methodId: r.methodId, amount: money(amount), reference: r.reference.trim() }] : [];
  });

/** What has been handed over in all, and how far that is from the total (nothing short when it covers it). */
export function paymentState(total: number, rows: readonly TypedTender[]): { paid: number; short: number; change: number } {
  const paid = money(tendersOf(rows).reduce((n, t) => n + t.amount, 0));
  return { paid, short: money(Math.max(total - paid, 0)), change: money(Math.max(paid - total, 0)) };
}
