import { and, asc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliverySlots, orders, orderSlotRequests, packageInstancePicks, packageInstances } from '@/server/db/drizzle/schema';
import { buildSheet, type PreparationRow, type PreparationSheet } from './domain/preparation';

/** The most selections one sheet shows; past it the sheet says so, and a package or a day can be chosen to narrow it. */
export const SHEET_LIMIT = 2000;

export interface PreparationDay {
  date: string;
  orders: number;
  servings: number;
}

export interface PreparationView {
  /** The day this sheet is for (`YYYY-MM-DD`), or null for the orders that have no date. */
  day: string | null;
  sheet: PreparationSheet;
  /** More selections than the sheet holds: it shows the first ones. */
  truncated: boolean;
  /** The coming days that have orders, for moving between days. */
  days: PreparationDay[];
}

/**
 * What has to be made for a day, read from the saved selections of orders that still stand (a cancelled order is not prepared).
 * Two queries for the sheet however many selections there are, and one for the days; nothing is read per order.
 */
export class PreparationService {
  constructor(private readonly db: DrizzleDb) {}

  async forDay(companyId: string, day: string | null, from: string): Promise<PreparationView> {
    const rows = await this.db
      .select({
        instanceId: packageInstances.id,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        paymentStatus: orders.paymentStatus,
        packageProductId: packageInstances.packageProductId,
        packageName: packageInstances.packageName,
        servings: packageInstances.servings,
        slotName: deliverySlots.name,
        slotStartsAt: deliverySlots.startsAt,
      })
      .from(packageInstances)
      .innerJoin(orders, and(eq(orders.id, packageInstances.documentId), eq(packageInstances.documentType, 'order')))
      .leftJoin(orderSlotRequests, eq(orderSlotRequests.orderId, orders.id))
      .leftJoin(deliverySlots, eq(deliverySlots.id, orderSlotRequests.slotId))
      .where(and(eq(packageInstances.companyId, companyId), day === null ? isNull(packageInstances.forDate) : eq(packageInstances.forDate, day), ne(orders.status, 'cancelled')))
      .orderBy(asc(packageInstances.createdAt))
      .limit(SHEET_LIMIT + 1);
    const truncated = rows.length > SHEET_LIMIT;
    const kept = truncated ? rows.slice(0, SHEET_LIMIT) : rows;
    const picks = kept.length === 0 ? [] : await this.db.select().from(packageInstancePicks).where(inArray(packageInstancePicks.instanceId, kept.map((r) => r.instanceId))).orderBy(asc(packageInstancePicks.sortOrder));
    const picksOf = new Map<string, PreparationRow['picks']>();
    for (const p of picks) {
      const list = picksOf.get(p.instanceId) ?? [];
      list.push({ slotName: p.slotName, productId: p.productId, productName: p.productName, count: p.count, quantity: p.quantity, sortOrder: p.sortOrder });
      picksOf.set(p.instanceId, list);
    }
    const sheet = buildSheet(kept.map((r) => ({ ...r, picks: picksOf.get(r.instanceId) ?? [] })));

    const upcoming = await this.db
      .select({ date: packageInstances.forDate, orders: sql<string>`count(distinct ${packageInstances.documentId})`, servings: sql<string>`sum(${packageInstances.servings})` })
      .from(packageInstances)
      .innerJoin(orders, and(eq(orders.id, packageInstances.documentId), eq(packageInstances.documentType, 'order')))
      .where(and(eq(packageInstances.companyId, companyId), gte(packageInstances.forDate, from), ne(orders.status, 'cancelled')))
      .groupBy(packageInstances.forDate)
      .orderBy(asc(packageInstances.forDate))
      .limit(31);
    return {
      day,
      sheet,
      truncated,
      days: upcoming.flatMap((u) => (u.date === null ? [] : [{ date: u.date, orders: Number(u.orders), servings: Number(u.servings) }])),
    };
  }
}
