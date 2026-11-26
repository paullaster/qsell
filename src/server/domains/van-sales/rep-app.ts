import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, orderItems, orders, products, salesReps, salesRoutes, vanDayOrders, vanDays, vanVisits, vans } from '@/server/db/drizzle/schema';
import { DAY_STATUS_WORDS, readDayStatus, type DayStatus } from '@/lib/van-sales/days';
import { isId } from '@/lib/van-sales/people';
import { ROUTE_MODE_WORDS, type RouteMode } from '@/lib/van-sales/settings';
import { businessDate } from '@/server/kernel/numbering/business-date';

export interface RepDayCard {
  id: string;
  number: string;
  /** `YYYY-MM-DD`. */
  date: string;
  isToday: boolean;
  routeName: string;
  vanName: string | null;
  status: DayStatus;
  statusWords: string;
  modeWords: string;
  visits: number;
  visitsDone: number;
  /** The next customer to see: the one the rep is at, or the first still to visit. */
  next: string | null;
}

export interface UsualLine {
  productId: string;
  name: string;
  quantity: number;
}

export interface UsualView {
  visitId: string;
  /** When the customer last bought, and the order number. */
  orderNumber: string;
  lines: UsualLine[];
}

const OPEN: DayStatus[] = ['planned', 'loading', 'out', 'returning', 'reconciling'];
const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const modeWords = (mode: string): string => ROUTE_MODE_WORDS[mode === 'van_sell' || mode === 'pre_sell' ? (mode satisfies RouteMode) : 'both'];

/**
 * What the rep's phone shows (docs/architecture/van-sales.md §10): the days that are theirs to run, and what each customer at a visit usually buys,
 * so a repeat order is one tap. Read only; everything the rep does is done through the same actions as the office screens.
 */
export class RepAppService {
  constructor(private readonly db: DrizzleDb) {}

  /** The days still to run or running for this person, from yesterday to a fortnight ahead, or null when they are not set up as a rep. */
  async myDays(companyId: string, userId: string): Promise<{ repName: string; today: string; days: RepDayCard[] } | null> {
    const [rep] = await this.db.select({ id: salesReps.id, name: salesReps.name }).from(salesReps).where(and(eq(salesReps.companyId, companyId), eq(salesReps.userId, userId)));
    if (rep === undefined) return null;
    const today = businessDate();
    const rows = await this.db
      .select({ d: vanDays, route: salesRoutes.name, van: vans.name })
      .from(vanDays)
      .innerJoin(salesRoutes, eq(salesRoutes.id, vanDays.routeId))
      .leftJoin(vans, eq(vans.id, vanDays.vanId))
      .where(and(eq(vanDays.companyId, companyId), eq(vanDays.repId, rep.id), inArray(vanDays.status, OPEN), gte(vanDays.dayDate, addDays(today, -1)), lte(vanDays.dayDate, addDays(today, 14))))
      .orderBy(asc(vanDays.dayDate), asc(vanDays.id))
      .limit(20);
    if (rows.length === 0) return { repName: rep.name, today, days: [] };
    const visits = await this.db
      .select({ dayId: vanVisits.dayId, status: vanVisits.status, name: customers.name, sequence: vanVisits.sequence })
      .from(vanVisits)
      .innerJoin(customers, eq(customers.id, vanVisits.customerId))
      .where(inArray(vanVisits.dayId, rows.map((r) => r.d.id)))
      .orderBy(asc(vanVisits.sequence));
    const days = rows.map((r): RepDayCard => {
      const own = visits.filter((v) => v.dayId === r.d.id);
      const status = readDayStatus(r.d.status) ?? 'planned';
      const at = own.find((v) => v.status === 'arrived') ?? own.find((v) => v.status === 'planned');
      return {
        id: r.d.id,
        number: r.d.number,
        date: r.d.dayDate,
        isToday: r.d.dayDate === today,
        routeName: r.route,
        vanName: r.van,
        status,
        statusWords: DAY_STATUS_WORDS[status],
        modeWords: modeWords(r.d.mode),
        visits: own.length,
        visitsDone: own.filter((v) => v.status === 'done' || v.status === 'skipped' || v.status === 'closed_shop').length,
        next: status === 'out' ? (at?.name ?? null) : null,
      };
    });
    return { repName: rep.name, today, days };
  }

  /** What each customer at a visit under way last bought through a van, to repeat in one tap. */
  async usual(companyId: string, dayId: string): Promise<UsualView[]> {
    if (!isId(dayId)) return [];
    const visits = await this.db.select({ id: vanVisits.id, customerId: vanVisits.customerId }).from(vanVisits).where(and(eq(vanVisits.dayId, dayId), eq(vanVisits.status, 'arrived')));
    const out: UsualView[] = [];
    for (const v of visits) {
      const [last] = await this.db
        .select({ orderId: vanDayOrders.orderId })
        .from(vanDayOrders)
        .innerJoin(vanVisits, eq(vanVisits.id, vanDayOrders.visitId))
        .where(and(eq(vanDayOrders.companyId, companyId), eq(vanVisits.customerId, v.customerId), inArray(vanDayOrders.kind, ['cash', 'credit', 'order']), sql`${vanVisits.dayId} <> ${dayId}::uuid`))
        .orderBy(desc(vanDayOrders.createdAt))
        .limit(1);
      if (last === undefined) continue;
      const lines = await this.db.select({ productId: orderItems.productId, name: products.name, quantity: orderItems.quantity }).from(orderItems).innerJoin(products, eq(products.id, orderItems.productId)).where(eq(orderItems.orderId, last.orderId)).orderBy(asc(orderItems.lineNo)).limit(20);
      const [header] = await this.db.select({ n: orders.orderNumber }).from(orders).where(eq(orders.id, last.orderId));
      out.push({ visitId: v.id, orderNumber: header?.n ?? '', lines: lines.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity })) });
    }
    return out;
  }
}
