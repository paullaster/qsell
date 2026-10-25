import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { purchaseOrderLines, supplierInvoiceEvents, supplierInvoiceLineRgn, supplierInvoiceLines, supplierInvoices, vendorSettings, type SupplierInvoiceState } from '@/server/db/drizzle/schema';
import { DEFAULT_TOLERANCES, type Tolerances } from '@/lib/supplier-invoice';

export type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
export interface Actor {
  type: 'user' | 'system' | 'job' | 'integration';
  id: string | null;
}

/** States in which an invoice has handed itself to our side and so holds a claim on the goods it names. */
export const CLAIMING: SupplierInvoiceState[] = ['submitted', 'received', 'rgn_linked', 'matched', 'pending_approval', 'approved'];
/** States in which staff have linked received goods to its lines, so those links hold the goods. */
export const LINK_HOLDING: SupplierInvoiceState[] = ['received', 'rgn_linked', 'matched', 'pending_approval', 'approved'];

export async function writeEvent(
  tx: Tx | DrizzleDb,
  actor: Actor,
  invoiceId: string,
  event: string,
  from: string | null,
  to: string | null,
  extra: { reason?: string | null; data?: Record<string, unknown> } = {},
): Promise<void> {
  await tx.insert(supplierInvoiceEvents).values({ invoiceId, event, fromState: from, toState: to, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: actor.type, actorId: actor.id });
}

export async function tolerancesOf(db: Tx | DrizzleDb, companyId: string): Promise<Tolerances> {
  const [s] = await db.select().from(vendorSettings).where(eq(vendorSettings.companyId, companyId));
  if (s === undefined) return DEFAULT_TOLERANCES;
  return {
    quantityPercent: Number(s.invoiceQuantityTolerancePercent),
    pricePercent: Number(s.invoicePriceTolerancePercent),
    priceAmountCents: Math.round(Number(s.invoicePriceToleranceAmount) * 100),
  };
}

export interface PoLineRoom {
  poLineId: string;
  ordered: number;
  received: number;
  invoiced: number;
  /** What other invoices on our side already claim on this line. */
  claimed: number;
  /** Quantity still open to invoice against goods that arrived. */
  goodsRoom: number;
  /** Quantity still open to invoice against an advance (goods not needed). */
  advanceRoom: number;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** What each line of an order has room for, apart from one invoice (the one being worked on). */
export async function roomsFor(db: Tx | DrizzleDb, poId: string, exceptInvoiceId: string | null): Promise<Map<string, PoLineRoom>> {
  const lines = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
  const claims = await db
    .select({ poLineId: supplierInvoiceLines.poLineId, q: sql<string>`COALESCE(SUM(${supplierInvoiceLines.quantity}), 0)::text` })
    .from(supplierInvoiceLines)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceLines.invoiceId))
    .where(and(eq(supplierInvoices.poId, poId), inArray(supplierInvoices.state, CLAIMING), exceptInvoiceId === null ? undefined : ne(supplierInvoices.id, exceptInvoiceId)))
    .groupBy(supplierInvoiceLines.poLineId);
  const claimed = new Map(claims.map((c) => [c.poLineId, Number(c.q)]));
  const out = new Map<string, PoLineRoom>();
  for (const l of lines) {
    const ordered = Number(l.quantity) - Number(l.cancelledQuantity);
    const taken = claimed.get(l.id) ?? 0;
    out.set(l.id, {
      poLineId: l.id,
      ordered: round(ordered),
      received: Number(l.receivedQuantity),
      invoiced: Number(l.invoicedQuantity),
      claimed: round(taken),
      goodsRoom: Math.max(0, round(Number(l.receivedQuantity) - Number(l.invoicedQuantity) - taken)),
      advanceRoom: Math.max(0, round(ordered - Number(l.invoicedQuantity) - taken)),
    });
  }
  return out;
}

/** What other invoices in process already hold of each received goods line (their stage 1 links). */
export async function heldByOthers(db: Tx | DrizzleDb, rgnLineIds: readonly string[], exceptInvoiceId: string): Promise<Map<string, number>> {
  if (rgnLineIds.length === 0) return new Map();
  const rows = await db
    .select({ rgnLineId: supplierInvoiceLineRgn.rgnLineId, q: sql<string>`COALESCE(SUM(${supplierInvoiceLineRgn.quantity}), 0)::text` })
    .from(supplierInvoiceLineRgn)
    .innerJoin(supplierInvoiceLines, eq(supplierInvoiceLines.id, supplierInvoiceLineRgn.invoiceLineId))
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceLines.invoiceId))
    .where(and(inArray(supplierInvoiceLineRgn.rgnLineId, [...rgnLineIds]), inArray(supplierInvoices.state, LINK_HOLDING), ne(supplierInvoices.id, exceptInvoiceId)))
    .groupBy(supplierInvoiceLineRgn.rgnLineId);
  return new Map(rows.map((r) => [r.rgnLineId, Number(r.q)]));
}
