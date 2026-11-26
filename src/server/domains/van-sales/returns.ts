import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { counterReturns, customers, orders, paymentMethods, vanDayOrders, vanDayReturns, vanDays, vanVisits } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { CounterReturnService } from '@/server/domains/selling/cash-sales/counter-return-service';
import { isId } from '@/lib/van-sales/people';
import { readVanReturn, returnProblem } from '@/lib/van-sales/returns';
import { recordDayEvent } from './day-events';
import { VanSalesError } from './errors';
import { ownDay } from './own-day';

export interface ReturnableLine {
  productId: string;
  description: string;
  unitPrice: number;
  remainingQuantity: number;
}

export interface ReturnableSale {
  visitId: string;
  orderId: string;
  orderNumber: string;
  at: string;
  lines: ReturnableLine[];
}

export interface RefundChoice {
  id: string;
  name: string;
  kind: string;
}

export interface ReturnMade {
  id: string;
  visitId: string;
  customerName: string;
  orderNumber: string;
  amount: number;
  restock: boolean;
  status: string;
  at: string;
}

/**
 * Goods a customer gives back to the rep at a visit (docs/architecture/van-sales.md §7). Only a cash sale made to this customer from this same van
 * can be returned here, so the goods that are fit to be sold again go back on the van they came from. The return is an ordinary counter return: a
 * credit note, the stock counted back, and the cash handed back out of the van's till shift, with the same key making a repeat safe.
 */
export class VanReturnService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly counter: CounterReturnService,
  ) {}

  /** The ways a customer can be paid back from the van: cash handed over from the till, or M-Pesa to a number. */
  async refundMethods(companyId: string): Promise<RefundChoice[]> {
    const rows = await this.db
      .select({ id: paymentMethods.id, name: paymentMethods.name, kind: paymentMethods.kind })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), sql`${paymentMethods.kind} IN ('cash', 'mobile_money')`, sql`${paymentMethods.usableFor} @> '["customer_refund"]'::jsonb`, sql`${paymentMethods.refundDestination} <> 'none'`))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name));
    return rows;
  }

  /** The cash sales from this van to the customers at visits under way, with what of each can still be returned. */
  async returnable(companyId: string, dayId: string): Promise<ReturnableSale[]> {
    if (!isId(dayId)) return [];
    const [day] = await this.db.select({ vanId: vanDays.vanId }).from(vanDays).where(and(eq(vanDays.id, dayId), eq(vanDays.companyId, companyId)));
    if (day?.vanId === null || day === undefined) return [];
    const visits = await this.db.select({ id: vanVisits.id, customerId: vanVisits.customerId }).from(vanVisits).where(and(eq(vanVisits.dayId, dayId), eq(vanVisits.status, 'arrived')));
    const out: ReturnableSale[] = [];
    for (const v of visits) {
      const sales = await this.db
        .select({ orderId: orders.id, number: orders.orderNumber, at: vanDayOrders.createdAt })
        .from(vanDayOrders)
        .innerJoin(vanDays, eq(vanDays.id, vanDayOrders.dayId))
        .innerJoin(orders, eq(orders.id, vanDayOrders.orderId))
        .innerJoin(vanVisits, eq(vanVisits.id, vanDayOrders.visitId))
        .where(and(eq(vanDayOrders.companyId, companyId), eq(vanDayOrders.kind, 'cash'), eq(vanDays.vanId, day.vanId), eq(vanVisits.customerId, v.customerId)))
        .orderBy(desc(vanDayOrders.createdAt))
        .limit(10);
      for (const sale of sales) {
        const open = await this.counter.returnable(companyId, sale.orderId);
        if (open.ok) out.push({ visitId: v.id, orderId: sale.orderId, orderNumber: sale.number, at: sale.at.toISOString(), lines: open.lines.map((l) => ({ productId: l.productId, description: l.description, unitPrice: l.unitPrice, remainingQuantity: l.remainingQuantity })) });
      }
    }
    return out;
  }

  /** The returns taken on the day, in order. */
  async forDay(companyId: string, dayId: string): Promise<ReturnMade[]> {
    if (!isId(dayId)) return [];
    const rows = await this.db
      .select({ r: vanDayReturns, status: counterReturns.status, number: orders.orderNumber, customer: customers.name })
      .from(vanDayReturns)
      .innerJoin(counterReturns, eq(counterReturns.id, vanDayReturns.counterReturnId))
      .innerJoin(orders, eq(orders.id, vanDayReturns.orderId))
      .innerJoin(vanVisits, eq(vanVisits.id, vanDayReturns.visitId))
      .innerJoin(customers, eq(customers.id, vanVisits.customerId))
      .where(and(eq(vanDayReturns.companyId, companyId), eq(vanDayReturns.dayId, dayId)))
      .orderBy(asc(vanDayReturns.createdAt), asc(vanDayReturns.id))
      .limit(200);
    return rows.map((r) => ({ id: r.r.id, visitId: r.r.visitId, customerName: r.customer, orderNumber: r.number, amount: Number(r.r.amount), restock: r.r.restock, status: r.status, at: r.r.createdAt.toISOString() }));
  }

  /** Takes goods back from the customer the rep is at, and pays them back. */
  async take(companyId: string, actor: Actor, dayId: string, raw: unknown, maySell: boolean): Promise<void> {
    const own = await ownDay(this.db, companyId, actor, dayId, maySell);
    const read = readVanReturn(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const r = read.ret;
    const [visit] = await this.db.select({ id: vanVisits.id, status: vanVisits.status, customerId: customers.id, name: customers.name }).from(vanVisits).innerJoin(customers, eq(customers.id, vanVisits.customerId)).where(and(eq(vanVisits.id, r.visitId), eq(vanVisits.dayId, dayId))).limit(1);
    if (visit === undefined) throw new VanSalesError('That visit could not be found on this day.');
    const [sale] = await this.db
      .select({ customerId: vanVisits.customerId, vanId: vanDays.vanId })
      .from(vanDayOrders)
      .innerJoin(vanDays, eq(vanDays.id, vanDayOrders.dayId))
      .innerJoin(vanVisits, eq(vanVisits.id, vanDayOrders.visitId))
      .where(and(eq(vanDayOrders.orderId, r.orderId), eq(vanDayOrders.kind, 'cash'), eq(vanDayOrders.companyId, companyId)))
      .limit(1);
    if (sale === undefined) throw new VanSalesError('That sale was not made from a van, so it cannot be returned here.');
    const problem = returnProblem({ dayStatus: own.d.status, visitStatus: visit.status, customerName: visit.name, saleIsCustomers: sale.customerId === visit.customerId, saleOnThisVan: sale.vanId === own.d.vanId });
    if (problem !== null) throw new VanSalesError(problem);

    const done = await this.counter.run(companyId, { userId: actor.id ?? '' }, { orderId: r.orderId, lines: r.lines, reason: r.reason, restock: r.restock, ...(own.vanLocationId === null ? {} : { backTo: own.vanLocationId }), refund: r.refund, key: r.key });
    const [row] = await this.db.select({ id: counterReturns.id, amount: counterReturns.amount }).from(counterReturns).where(and(eq(counterReturns.idempotencyKey, r.key), eq(counterReturns.companyId, companyId)));
    if (row !== undefined) {
      await this.db.transaction(async (tx) => {
        const made = await tx.insert(vanDayReturns).values({ companyId, dayId, visitId: visit.id, orderId: r.orderId, counterReturnId: row.id, amount: row.amount, restock: r.restock, createdBy: actor.id ?? 'system' }).onConflictDoNothing().returning({ id: vanDayReturns.id });
        if (made.length > 0) await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.returned', { detail: { customer: visit.name, amount: Number(row.amount), restock: r.restock } });
      });
    }
    if (!done.ok) throw new VanSalesError(done.unfinished === undefined ? done.error : `${done.error} Press the button again to finish it: nothing will be done twice.`);
  }
}
