import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { purchaseInvoices, supplierInvoiceLines, vendorCreditMemoEvents, vendorCreditMemoLines, vendorCreditMemos } from '@/server/db/drizzle/schema';
import { CREDIT_CLAIMING, type OriginalLine } from '@/lib/vendor-credit-memo';

export type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
export interface Actor {
  type: 'user' | 'system' | 'job' | 'integration';
  id: string | null;
}

export async function writeMemoEvent(
  tx: Tx | DrizzleDb,
  actor: Actor,
  memoId: string,
  event: string,
  from: string | null,
  to: string | null,
  extra: { reason?: string | null; data?: Record<string, unknown> } = {},
): Promise<void> {
  await tx.insert(vendorCreditMemoEvents).values({ memoId, event, fromState: from, toState: to, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: actor.type, actorId: actor.id });
}

const cents = (s: string): number => Math.round(Number(s) * 100);

/**
 * The lines of a booked invoice as a credit memo sees them: what was billed, and what other credit memos (submitted, approved or
 * booked) already take off it. `exceptMemoId` leaves one memo out, the one being worked on.
 */
export async function originalLines(db: Tx | DrizzleDb, purchaseInvoiceId: string, exceptMemoId: string | null): Promise<Map<string, OriginalLine>> {
  const [inv] = await db.select({ supplierInvoiceId: purchaseInvoices.supplierInvoiceId }).from(purchaseInvoices).where(eq(purchaseInvoices.id, purchaseInvoiceId));
  if (inv === undefined) return new Map();
  const lines = await db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.supplierInvoiceId));
  const claimed = await db
    .select({
      invoiceLineId: vendorCreditMemoLines.invoiceLineId,
      qty: sql<string>`COALESCE(SUM(CASE WHEN ${vendorCreditMemoLines.mode} = 'quantity' THEN ${vendorCreditMemoLines.quantity} ELSE 0 END), 0)::text`,
      net: sql<string>`COALESCE(SUM(${vendorCreditMemoLines.netAmount}), 0)::text`,
    })
    .from(vendorCreditMemoLines)
    .innerJoin(vendorCreditMemos, eq(vendorCreditMemos.id, vendorCreditMemoLines.memoId))
    .where(and(inArray(vendorCreditMemoLines.invoiceLineId, lines.map((l) => l.id)), inArray(vendorCreditMemos.state, [...CREDIT_CLAIMING]), exceptMemoId === null ? undefined : ne(vendorCreditMemos.id, exceptMemoId)))
    .groupBy(vendorCreditMemoLines.invoiceLineId);
  const by = new Map(claimed.map((c) => [c.invoiceLineId, c]));
  return new Map(
    lines.map((l) => [
      l.id,
      { id: l.id, description: l.description, quantity: Number(l.quantity), unitPriceCents: cents(l.unitPrice), taxRate: Number(l.taxRate), netCents: cents(l.netAmount), creditedQuantity: Number(by.get(l.id)?.qty ?? '0'), creditedNetCents: cents(by.get(l.id)?.net ?? '0') },
    ]),
  );
}
