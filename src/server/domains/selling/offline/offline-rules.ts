/**
 * Offline selling at the counter (docs/architecture/offline-selling.md): the sale as the till sends it, how it is signed so that a change
 * after it was rung up is seen, and the limits that keep it honest. Pure: no clock, no database; the till and the server both use it, each
 * with its own way of computing the signature (the browser's, the server's) over the same text.
 */

export const OFFLINE_DEFAULTS = { maxPerShift: 50_000, maxHours: 24 } as const;
export const MAX_OFFLINE_LINES = 100;
export const MAX_OFFLINE_TENDERS = 4;

export interface OfflineLine {
  productId: string;
  quantity: number;
  /** The price of one, tax included, as the till showed it. */
  unitPrice: number;
}
export interface OfflineTender {
  methodId: string;
  /** Cash: what was handed over. Others: what was paid with it. */
  amount: number;
  reference: string;
}
export interface OfflineSale {
  /** One key for one sale: a repeat of it changes nothing. */
  key: string;
  shiftId: string;
  /** What the customer was given: the till's own reference (the real receipt follows on sync). */
  deviceRef: string;
  /** The time on the till's clock, ISO. */
  deviceTime: string;
  lines: OfflineLine[];
  tenders: OfflineTender[];
  /** What the customer was charged, tax included. */
  total: number;
}
export interface SignedOfflineSale extends OfflineSale {
  signature: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const cents = (amount: number): number => Math.round(amount * 100);
const isMoney = (amount: unknown): amount is number => typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && amount <= 100_000_000 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
const isQuantity = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000 && Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6;

/** What a sale's lines come to, in cents: each line's price times its quantity, rounded to the cent. */
export const linesTotalCents = (lines: readonly OfflineLine[]): number => lines.reduce((sum, l) => sum + Math.round(l.unitPrice * l.quantity * 100), 0);

/**
 * The text a sale is signed over: the same on the till and on the server, field by field in a fixed order, money to the cent and
 * quantities to the thousandth, so a number written two ways cannot make two signatures.
 */
export function canonicalSale(sale: OfflineSale): string {
  const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
  return JSON.stringify([
    'qsell-offline-sale-v1',
    sale.key,
    sale.shiftId,
    sale.deviceRef,
    sale.deviceTime,
    sale.lines.map((l) => [l.productId, (Math.round(l.quantity * 1000) / 1000).toFixed(3), money(l.unitPrice)]),
    sale.tenders.map((t) => [t.methodId, money(t.amount), t.reference]),
    money(sale.total),
  ]);
}

/** Compares two signatures without stopping at the first difference. */
export function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Reads a sale as the till sent it (untrusted): the shape and the sums, never the prices' truth. */
export function parseOfflineSale(raw: unknown): { ok: true; sale: SignedOfflineSale } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'The sale could not be read.' };
  const key = text(raw.key, 40);
  const shiftId = text(raw.shiftId, 40);
  const deviceRef = text(raw.deviceRef, 60);
  const deviceTime = text(raw.deviceTime, 40);
  const signature = text(raw.signature, 128);
  if (!UUID.test(key) || !UUID.test(shiftId)) return { ok: false, error: 'The sale has no valid key or shift.' };
  if (deviceRef === '' || Number.isNaN(Date.parse(deviceTime))) return { ok: false, error: 'The sale has no device reference or time.' };
  if (!/^[0-9a-f]{64}$/.test(signature)) return { ok: false, error: 'The sale is not signed.' };
  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > MAX_OFFLINE_LINES) return { ok: false, error: 'The sale has no lines, or too many.' };
  const lines: OfflineLine[] = [];
  for (const entry of raw.lines) {
    if (!isRecord(entry)) return { ok: false, error: 'A line could not be read.' };
    const productId = text(entry.productId, 100);
    if (productId === '' || !isQuantity(entry.quantity) || !isMoney(entry.unitPrice)) return { ok: false, error: 'A line has no product, a bad quantity or a bad price.' };
    if (lines.some((l) => l.productId === productId)) return { ok: false, error: 'A product is on the sale twice.' };
    lines.push({ productId, quantity: entry.quantity, unitPrice: entry.unitPrice });
  }
  if (!Array.isArray(raw.tenders) || raw.tenders.length === 0 || raw.tenders.length > MAX_OFFLINE_TENDERS) return { ok: false, error: 'The sale has no payment, or too many.' };
  const tenders: OfflineTender[] = [];
  for (const entry of raw.tenders) {
    if (!isRecord(entry)) return { ok: false, error: 'A payment could not be read.' };
    const methodId = text(entry.methodId, 40);
    if (!UUID.test(methodId) || !isMoney(entry.amount)) return { ok: false, error: 'A payment has no valid way of paying or amount.' };
    tenders.push({ methodId, amount: entry.amount, reference: text(entry.reference, 60) });
  }
  if (!isMoney(raw.total)) return { ok: false, error: 'The sale has no valid total.' };
  if (linesTotalCents(lines) !== cents(raw.total)) return { ok: false, error: 'The total is not what the lines come to.' };
  return { ok: true, sale: { key, shiftId, deviceRef, deviceTime, lines, tenders, total: raw.total, signature } };
}

export interface OfflineLimits {
  maxPerShift: number;
  maxHours: number;
}

/**
 * Whether a sale may still be accepted: not past the most that can be sold offline in a shift, and not waiting longer than allowed.
 * `soldSoFar` is what the shift's other offline sales came to; `waitedMs` how long this one waited from the till's clock to the server's.
 */
export function limitProblem(input: { limits: OfflineLimits; soldSoFar: number; total: number; waitedMs: number }): string | null {
  if (input.soldSoFar + input.total > input.limits.maxPerShift + 1e-9) return `This shift has sold ${String(Math.round(input.soldSoFar))} offline and the most allowed is ${String(input.limits.maxPerShift)}.`;
  if (input.waitedMs > input.limits.maxHours * 3_600_000) return `This sale waited more than ${String(input.limits.maxHours)} hours to be sent, which is the longest allowed.`;
  return null;
}

/** What the till shows its cashier before another offline sale is rung up: whether the shift may still sell offline. */
export const offlineRoom = (limits: OfflineLimits, soldSoFar: number): number => Math.max(0, Math.round((limits.maxPerShift - soldSoFar) * 100) / 100);

export const limitsProblem = (limits: OfflineLimits): string | null => {
  if (!Number.isFinite(limits.maxPerShift) || limits.maxPerShift <= 0 || limits.maxPerShift > 10_000_000) return 'The most that can be sold offline in a shift must be from 1 to 10,000,000.';
  if (!Number.isInteger(limits.maxHours) || limits.maxHours < 1 || limits.maxHours > 168) return 'The longest an offline sale may wait must be a whole number of hours from 1 to 168.';
  return null;
};

/** What a flag on an accepted offline sale means, in words (for the people who look at it). */
const FLAG_WORDS: Record<string, string> = {
  price_differs: 'The price now is not the price the customer was charged.',
  no_longer_sold: 'A product is no longer sold at the counter.',
  clock_ahead: 'The till\'s clock was ahead of the server\'s.',
};
export const flagWords = (flag: string): string => FLAG_WORDS[flag] ?? flag;
