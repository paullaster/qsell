/**
 * What the browser may ask for when a receipt is posted or applied, checked before it reaches the books: the oldest invoices, nothing,
 * or named invoices with an amount each. Pure. The ledger checks every figure again against the locked rows.
 */
export type AllocationRequest = 'oldest_first' | 'none' | { entryId: string; amount: string }[];
export type PlannedAllocation = 'oldest_first' | 'none' | { entryId: string; amountCents: number }[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
export const MAX_CHOSEN_INVOICES = 200;

export function parseAllocationRequest(request: unknown): { ok: true; value: PlannedAllocation; named: boolean } | { ok: false; error: string } {
  if (request === 'oldest_first' || request === 'none') return { ok: true, value: request, named: false };
  if (!Array.isArray(request) || request.length === 0 || request.length > MAX_CHOSEN_INVOICES) {
    return { ok: false, error: 'Choose at least one invoice and an amount for it.' };
  }
  const seen = new Set<string>();
  const planned: { entryId: string; amountCents: number }[] = [];
  for (const item of request as unknown[]) {
    const entry = typeof item === 'object' && item !== null ? (item as { entryId?: unknown; amount?: unknown }) : {};
    const amount = typeof entry.amount === 'string' ? entry.amount.trim() : '';
    if (typeof entry.entryId !== 'string' || !UUID.test(entry.entryId) || !MONEY.test(amount)) {
      return { ok: false, error: 'One of the invoice amounts is not a valid amount.' };
    }
    const cents = Math.round(Number(amount) * 100);
    if (cents <= 0) return { ok: false, error: 'One of the invoice amounts is not a valid amount.' };
    if (seen.has(entry.entryId)) return { ok: false, error: 'An invoice was chosen twice.' };
    seen.add(entry.entryId);
    planned.push({ entryId: entry.entryId, amountCents: cents });
  }
  return { ok: true, value: planned, named: true };
}
