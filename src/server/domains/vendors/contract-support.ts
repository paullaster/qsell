import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { purchaseOrderLines, purchaseOrders, vendorContractLines } from '@/server/db/drizzle/schema';
import { toCents } from '@/lib/vendor-payment';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * What has been called off against a contract, counted from the orders themselves (cancelled orders and cancelled quantities do
 * not count), so there is no second figure to drift. Callers lock the contract row first, so two call-offs cannot both take the last of it.
 */
export async function contractUsage(db: Tx | DrizzleDb, contractId: string, exceptOrderId: string | null = null): Promise<{ perLine: Map<string, number>; valueCents: number }> {
  const lines = await db.select({ id: vendorContractLines.id }).from(vendorContractLines).where(eq(vendorContractLines.contractId, contractId));
  const perLine = new Map<string, number>(lines.map((l) => [l.id, 0]));
  if (lines.length > 0) {
    const used = await db
      .select({ lineId: purchaseOrderLines.contractLineId, qty: sql<string>`COALESCE(SUM(${purchaseOrderLines.quantity} - ${purchaseOrderLines.cancelledQuantity}), 0)::text` })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
      .where(and(inArray(purchaseOrderLines.contractLineId, lines.map((l) => l.id)), ne(purchaseOrders.status, 'cancelled'), exceptOrderId === null ? undefined : ne(purchaseOrders.id, exceptOrderId)))
      .groupBy(purchaseOrderLines.contractLineId);
    for (const u of used) if (u.lineId !== null) perLine.set(u.lineId, Number(u.qty));
  }
  const [v] = await db
    .select({ total: sql<string>`COALESCE(SUM(${purchaseOrders.total}), 0)::text` })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.contractId, contractId), ne(purchaseOrders.status, 'cancelled'), exceptOrderId === null ? undefined : ne(purchaseOrders.id, exceptOrderId)));
  return { perLine, valueCents: toCents(v?.total ?? '0') };
}
