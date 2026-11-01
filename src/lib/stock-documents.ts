/**
 * Transfers and counts: the states they move through and the sums that decide them. Pure; the services apply them under a lock.
 * Design: docs/architecture/stock-locations.md §4.5 to §4.7 and §8.
 */

export const TRANSFER_STATES = ['draft', 'requested', 'approved', 'shipped', 'partly_received', 'received', 'closed', 'cancelled'] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

export const COUNT_STATES = ['counting', 'counted', 'approved', 'posted', 'cancelled'] as const;
export type CountState = (typeof COUNT_STATES)[number];

export const DOCUMENT_STATES = [...new Set([...TRANSFER_STATES, ...COUNT_STATES])] as readonly string[];

export const COUNT_MODES = ['cycle', 'full'] as const;
export type CountMode = (typeof COUNT_MODES)[number];

export const MAX_DOCUMENT_LINES = 500;

/** Rounds to thousandths; adding zero turns a negative zero into zero. */
const round = (n: number): number => Math.round(n * 1000) / 1000 + 0;

/** What may happen to a transfer in each state. */
const TRANSFER_NEXT: Record<TransferState, readonly TransferState[]> = {
  draft: ['requested', 'cancelled'],
  requested: ['approved', 'shipped', 'cancelled'],
  approved: ['shipped', 'cancelled'],
  shipped: ['partly_received', 'received', 'closed'],
  partly_received: ['partly_received', 'received', 'closed'],
  received: [],
  closed: [],
  cancelled: [],
};

const COUNT_NEXT: Record<CountState, readonly CountState[]> = {
  counting: ['counted', 'cancelled'],
  counted: ['approved', 'posted', 'counting', 'cancelled'],
  approved: ['posted', 'cancelled'],
  posted: [],
  cancelled: [],
};

export function canTransferMove(from: TransferState, to: TransferState): boolean {
  return TRANSFER_NEXT[from].includes(to);
}

export function canCountMove(from: CountState, to: CountState): boolean {
  return COUNT_NEXT[from].includes(to);
}

export const isTransferState = (value: unknown): value is TransferState => typeof value === 'string' && (TRANSFER_STATES as readonly string[]).includes(value);
export const isCountState = (value: unknown): value is CountState => typeof value === 'string' && (COUNT_STATES as readonly string[]).includes(value);

/** A transfer's lines as far as the sums are concerned. */
export interface TransferLineSums {
  shipped: number;
  received: number;
  writtenOff: number;
  returned: number;
}

/** Stock of one line still on its way: shipped and not yet received, written off or sent back. */
export function inTransit(line: TransferLineSums): number {
  return round(line.shipped - line.received - line.writtenOff - line.returned);
}

/**
 * The state a transfer is in once it has left the warehouse, from what has happened to its lines. Nothing in transit and nothing lost
 * or sent back is "received"; nothing in transit but something lost or sent back is "closed"; otherwise it is still on its way.
 */
export function stateAfterMovement(lines: readonly TransferLineSums[]): 'shipped' | 'partly_received' | 'received' | 'closed' {
  const left = round(lines.reduce((sum, l) => sum + inTransit(l), 0));
  const settled = round(lines.reduce((sum, l) => sum + l.received + l.writtenOff + l.returned, 0));
  if (left > 0) return settled > 0 ? 'partly_received' : 'shipped';
  const resolved = round(lines.reduce((sum, l) => sum + l.writtenOff + l.returned, 0));
  return resolved > 0 ? 'closed' : 'received';
}

export interface QuantityLineInput {
  productId: unknown;
  quantity: unknown;
}

export type CheckedLines = { ok: true; lines: { productId: string; quantity: number }[] } | { ok: false; error: string };

const wholeThousandths = (n: number): boolean => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;

/** Checks the lines of a transfer as typed: some, no product twice, each a positive quantity of at most three decimals. */
export function checkTransferLines(raw: unknown): CheckedLines {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Add at least one product to move.' };
  if (raw.length > MAX_DOCUMENT_LINES) return { ok: false, error: `A transfer can have at most ${String(MAX_DOCUMENT_LINES)} lines.` };
  const seen = new Set<string>();
  const lines: { productId: string; quantity: number }[] = [];
  for (const entry of raw as (QuantityLineInput | null)[]) {
    const productId = typeof entry?.productId === 'string' ? entry.productId.trim() : '';
    if (productId === '' || productId.length > 100) return { ok: false, error: 'Every line needs a product.' };
    if (seen.has(productId)) return { ok: false, error: 'A product can be on a transfer only once. Add its quantities together.' };
    seen.add(productId);
    const quantity = entry?.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: 'Every quantity must be more than zero.' };
    if (!wholeThousandths(quantity)) return { ok: false, error: 'A quantity can have at most three decimals.' };
    lines.push({ productId, quantity: round(quantity) });
  }
  return { ok: true, lines };
}

/**
 * What a count found against what was expected. The shelf was counted at a moment; stock that moved between the snapshot and that
 * moment is part of what should have been there, so the variance is the counted figure minus (expected at the snapshot plus what moved
 * since). Counting does not need sales to stop.
 */
export function countVariance(expectedAtSnapshot: number, movedSinceUntilCounted: number, counted: number): number {
  return round(counted - round(expectedAtSnapshot + movedSinceUntilCounted));
}

/** The total value of a count's variances, ignoring their direction: what decides whether a second person must agree. */
export function varianceValue(lines: readonly { variance: number; unitCost: number }[]): number {
  return Math.round(lines.reduce((sum, l) => sum + Math.abs(l.variance) * l.unitCost, 0) * 100) / 100;
}

/** Whether a count's variances are large enough to need a second person. A limit of zero means never. */
export function countNeedsApproval(value: number, limit: number): boolean {
  return limit > 0 && value > limit;
}

export interface CountLineInput {
  productId: unknown;
  quantity: unknown;
}

export function checkCountEntries(raw: unknown): CheckedLines {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Enter at least one counted quantity.' };
  if (raw.length > MAX_DOCUMENT_LINES) return { ok: false, error: `Send at most ${String(MAX_DOCUMENT_LINES)} counted lines at a time.` };
  const seen = new Set<string>();
  const lines: { productId: string; quantity: number }[] = [];
  for (const entry of raw as (CountLineInput | null)[]) {
    const productId = typeof entry?.productId === 'string' ? entry.productId.trim() : '';
    if (productId === '' || productId.length > 100) return { ok: false, error: 'Every counted line needs a product.' };
    if (seen.has(productId)) return { ok: false, error: 'A product is counted once per entry.' };
    seen.add(productId);
    const quantity = entry?.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) return { ok: false, error: 'A counted quantity is zero or more.' };
    if (!wholeThousandths(quantity)) return { ok: false, error: 'A quantity can have at most three decimals.' };
    lines.push({ productId, quantity: round(quantity) });
  }
  return { ok: true, lines };
}

/** A transfer's state in the words a person uses, and how loudly to say it. */
export const TRANSFER_STATE_WORDS: Record<TransferState, { label: string; tone: 'gray' | 'sky' | 'amber' | 'green' | 'red' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  requested: { label: 'Waiting to be sent', tone: 'amber' },
  approved: { label: 'Approved, waiting to be sent', tone: 'sky' },
  shipped: { label: 'On its way', tone: 'sky' },
  partly_received: { label: 'Partly received', tone: 'amber' },
  received: { label: 'Received', tone: 'green' },
  closed: { label: 'Closed, some stock lost or sent back', tone: 'amber' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export const COUNT_STATE_WORDS: Record<CountState, { label: string; tone: 'gray' | 'sky' | 'amber' | 'green' | 'red' }> = {
  counting: { label: 'Being counted', tone: 'sky' },
  counted: { label: 'Counted, waiting to be posted', tone: 'amber' },
  approved: { label: 'Approved, waiting to be posted', tone: 'sky' },
  posted: { label: 'Posted', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};
