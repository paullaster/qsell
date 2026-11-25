import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, orders, orderTenders, vanDayOrders, vanVisits } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { CashSaleService, SaleSummary } from '@/server/domains/selling/cash-sales/cash-sale-service';
import type { SalesOrderService } from '@/server/domains/selling/sales-order-service';
import type { SalesOrderLineInput } from '@/server/domains/selling/domain/sales-order-input';
import { readDayStatus } from '@/lib/van-sales/days';
import { isId } from '@/lib/van-sales/people';
import { readOrder, readSale, readSaleLines, repSaleProblem, creditAmountProblem, type SaleKind, type SaleLine } from '@/lib/van-sales/sell';
import { routeModeProblem, type RouteMode } from '@/lib/van-sales/settings';
import { recordDayEvent } from './day-events';
import { VanSalesError } from './errors';
import { ownDay } from './own-day';
import type { VanSalesSettingsService } from './settings-service';

export interface VanSaleView extends SaleSummary {
  kind: SaleKind;
}

export interface OrderTakenView {
  orderNumber: string;
  total: number;
  customerName: string;
  waitingForApproval: boolean;
}

export interface DaySaleRow {
  orderId: string;
  orderNumber: string;
  customerName: string;
  kind: SaleKind | 'order';
  total: number;
  at: string;
  visitId: string;
}

export interface DaySales {
  rows: DaySaleRow[];
  /** What the day has sold, and how it was paid: cash, M-Pesa and card taken now, and what was put on customers' accounts. */
  totals: { all: number; cash: number; mobileMoney: number; card: number; credit: number };
  /** What the orders taken today come to: promised for later, not money taken, so not in `all`. */
  ordered: number;
}

export interface TenderChoice {
  id: string;
  name: string;
  kind: string;
  requiresReference: boolean;
}

const rowKind = (kind: string): SaleKind | 'order' => (kind === 'credit' || kind === 'order' ? kind : 'cash');
const modeOf = (value: string): RouteMode => (value === 'van_sell' || value === 'pre_sell' ? value : 'both');
const toLines = (lines: SaleLine[]): SalesOrderLineInput[] => lines.map((l) => ({ productId: l.productId, quantity: l.quantity, ...(l.unitPrice === undefined ? {} : { unitPrice: l.unitPrice }), ...(l.discount === undefined ? {} : { discount: l.discount }) }));

/**
 * Selling from the van (docs/architecture/van-sales.md §3, §8). A van sale is an ordinary cash sale (paid now, in the van's till shift) or credit
 * sale (on the customer's account), issued from the van's own stock and nowhere else, at the server's prices. The rep sells only at a visit they
 * have arrived at, within what their profile lets them do alone (a typed price, a discount, credit and how much of it in a day). A retry with
 * the same key finds the sale it made, so a dropped connection never sells twice. Each sale is tied to its day and visit.
 */
export class VanSaleService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly cashSales: CashSaleService,
    private readonly salesOrders: SalesOrderService,
    private readonly settings: VanSalesSettingsService,
  ) {}

  /** What the rep may do at this visit: the day is out, its mode allows it, the visit is under way and the customer can be sold to. */
  private async scene(companyId: string, actor: Actor, dayId: string, visitId: string, maySell: boolean, what: 'sell' | 'order' = 'sell') {
    const own = await ownDay(this.db, companyId, actor, dayId, maySell);
    if (readDayStatus(own.d.status) !== 'out') throw new VanSalesError('Selling is done while the day is out on the route. Send the day out first.');
    const modeProblem = routeModeProblem(await this.settings.current(companyId), modeOf(own.d.mode));
    if (modeProblem !== null) throw new VanSalesError(modeProblem);
    if (what === 'sell' && (modeOf(own.d.mode) === 'pre_sell' || own.vanLocationId === null)) throw new VanSalesError('This day only takes orders, so there is no van stock to sell from.');
    if (what === 'order' && modeOf(own.d.mode) === 'van_sell') throw new VanSalesError('This day only sells from the van. Orders are taken on a route that takes orders.');
    if (what === 'order' && !(await this.settings.current(companyId)).preSell) throw new VanSalesError('Taking orders is switched off for van sales.');
    if (!isId(visitId)) throw new VanSalesError('That visit could not be found.');
    const [visit] = await this.db.select({ v: vanVisits, name: customers.name, customerId: customers.id, blocked: customers.blocked, isActive: customers.isActive }).from(vanVisits).innerJoin(customers, eq(customers.id, vanVisits.customerId)).where(and(eq(vanVisits.id, visitId), eq(vanVisits.dayId, dayId))).limit(1);
    if (visit === undefined) throw new VanSalesError('That visit could not be found on this day.');
    if (visit.v.status !== 'arrived') throw new VanSalesError(`Arrive at ${visit.name} before selling to them.`);
    if (!visit.isActive) throw new VanSalesError(`${visit.name} is no longer in use, so nothing can be sold to them.`);
    if (visit.blocked !== 'none') throw new VanSalesError(`${visit.name} is blocked, so nothing can be sold to them.`);
    const limits = { maxDiscountPercent: Number(own.limits.maxDiscountPercent), maxCreditPerDay: Number(own.limits.maxCreditPerDay), mayOverridePrice: own.limits.mayOverridePrice, maySellOnCredit: own.limits.maySellOnCredit };
    return { own, visit, limits, vanLocationId: own.vanLocationId ?? '', who: { userId: actor.id ?? '', branchId: null } };
  }

  /** What the lines would total for this customer, priced by the server as the sale will be (nothing is saved). */
  async price(companyId: string, actor: Actor, dayId: string, raw: unknown, maySell: boolean) {
    const i = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const lines = readSaleLines(i.lines);
    if (!lines.ok) throw new VanSalesError(lines.error);
    const asOrder = i.kind === 'order';
    const kind: SaleKind = i.kind === 'credit' ? 'credit' : 'cash';
    const sc = await this.scene(companyId, actor, dayId, typeof i.visitId === 'string' ? i.visitId : '', maySell, asOrder ? 'order' : 'sell');
    const problem = asOrder ? null : repSaleProblem(sc.limits, { kind, lines: lines.lines });
    if (problem !== null) throw new VanSalesError(problem);
    const priced = await this.salesOrders.price(companyId, sc.who, { customerId: sc.visit.customerId, lines: toLines(lines.lines), paymentMethod: 'counter', neededOn: '', holdUntilPaid: false }, this.pricedAs(asOrder, kind));
    if (!priced.ok) throw new VanSalesError(priced.error);
    return priced;
  }

  private pricedAs(asOrder: boolean, kind: SaleKind): 'sales_order' | 'credit_sale' | 'pos_cash_sale' {
    if (asOrder) return 'sales_order';
    return kind === 'credit' ? 'credit_sale' : 'pos_cash_sale';
  }

  /** The ways a sale paid now can be paid in this branch (cash, M-Pesa, card). */
  async tenderChoices(companyId: string, branchId: string): Promise<TenderChoice[]> {
    return (await this.cashSales.tenderMethods(companyId, branchId)).map((m) => ({ id: m.id, name: m.name, kind: m.kind, requiresReference: m.requiresReference }));
  }

  /** Sells at a visit: paid now, or on the customer's account. */
  async sell(companyId: string, actor: Actor, dayId: string, raw: unknown, maySell: boolean): Promise<VanSaleView> {
    const read = readSale(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const sale = read.sale;
    const sc = await this.scene(companyId, actor, dayId, sale.visitId, maySell);
    const problem = repSaleProblem(sc.limits, sale);
    if (problem !== null) throw new VanSalesError(problem);
    const input = { customerId: sc.visit.customerId, lines: toLines(sale.lines) };

    if (sale.kind === 'cash') {
      if (sc.own.d.shiftId === null) throw new VanSalesError('The van\'s till is not open. Send the day out again, counting the float.');
      const result = await this.cashSales.complete(companyId, sc.who, { ...input, tenders: sale.tenders, saleKey: sale.saleKey, fromLocationId: sc.vanLocationId });
      if (!result.ok) {
        // The sale was rung up but its payment was not recorded: it belongs to this visit already, and the same key finishes it.
        if (result.unfinished !== undefined) await this.link(companyId, actor, sc.own.d.id, sc.visit.v.id, result.unfinished.orderId, 'cash', 0, result.unfinished.orderNumber, sc.visit.name);
        throw new VanSalesError(result.error);
      }
      await this.link(companyId, actor, sc.own.d.id, sc.visit.v.id, result.sale.orderId, 'cash', result.sale.total, result.sale.orderNumber, sc.visit.name);
      return { ...result.sale, kind: 'cash' };
    }

    const [existing] = await this.db.select({ id: orders.id, number: orders.orderNumber, total: orders.totalAmount }).from(orders).where(eq(orders.idempotencyKey, sale.saleKey)).limit(1);
    if (existing !== undefined) {
      await this.link(companyId, actor, sc.own.d.id, sc.visit.v.id, existing.id, 'credit', Number(existing.total), existing.number, sc.visit.name);
      return { ...(await this.cashSales.summary(existing.id)), kind: 'credit' };
    }
    const given = await this.creditGiven(sc.own.d.id);
    const placed = await this.salesOrders.place(companyId, sc.who, { ...input, paymentMethod: 'counter', neededOn: '', holdUntilPaid: false }, 'credit_sale', {
      idempotencyKey: sale.saleKey,
      fromLocationId: sc.vanLocationId,
      checkTotal: (totals) => creditAmountProblem(sc.limits, totals.totalAmount, given),
    });
    if (!placed.ok) throw new VanSalesError(placed.error);
    const summary = await this.cashSales.summary(placed.orderId);
    await this.link(companyId, actor, sc.own.d.id, sc.visit.v.id, placed.orderId, 'credit', summary.total, placed.orderNumber, sc.visit.name);
    return { ...summary, kind: 'credit', ...(placed.waitingForApproval ? { warning: 'This credit sale is waiting for approval before the goods are released.' } : {}) };
  }

  /**
   * Takes an order at a visit, for delivery later. It is an ordinary sales order, priced by the server, with the stock reserved at the warehouse;
   * it is the customer's to pay when it is delivered. A retry with the same key finds the order it made.
   */
  async order(companyId: string, actor: Actor, dayId: string, raw: unknown, maySell: boolean): Promise<OrderTakenView> {
    const read = readOrder(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const o = read.order;
    const sc = await this.scene(companyId, actor, dayId, o.visitId, maySell, 'order');
    const [existing] = await this.db.select({ id: orders.id, number: orders.orderNumber, total: orders.totalAmount, approval: orders.approvalStatus }).from(orders).where(eq(orders.idempotencyKey, o.saleKey)).limit(1);
    if (existing !== undefined) {
      await this.link(companyId, actor, sc.own.d.id, sc.visit.v.id, existing.id, 'order', Number(existing.total), existing.number, sc.visit.name);
      return { orderNumber: existing.number, total: Number(existing.total), customerName: sc.visit.name, waitingForApproval: existing.approval === 'pending' };
    }
    const placed = await this.salesOrders.place(companyId, sc.who, { customerId: sc.visit.customerId, lines: o.lines, paymentMethod: 'counter', neededOn: o.neededOn, holdUntilPaid: false }, 'sales_order', { idempotencyKey: o.saleKey });
    if (!placed.ok) throw new VanSalesError(placed.error);
    const [row] = await this.db.select({ total: orders.totalAmount }).from(orders).where(eq(orders.id, placed.orderId)).limit(1);
    const total = Number(row?.total ?? 0);
    await this.link(companyId, actor, sc.own.d.id, sc.visit.v.id, placed.orderId, 'order', total, placed.orderNumber, sc.visit.name);
    return { orderNumber: placed.orderNumber, total, customerName: sc.visit.name, waitingForApproval: placed.waitingForApproval };
  }

  /** What the day has put on customers' accounts so far, for the rep's limit. */
  private async creditGiven(dayId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<string>`COALESCE(SUM(${vanDayOrders.total}), 0)::text` }).from(vanDayOrders).where(and(eq(vanDayOrders.dayId, dayId), eq(vanDayOrders.kind, 'credit')));
    return Number(row?.n ?? 0);
  }

  /** Ties a sale to its day and visit, once (a retry finds it already tied), with a line in the day's history. */
  private async link(companyId: string, actor: Actor, dayId: string, visitId: string, orderId: string, kind: SaleKind | 'order', total: number, number: string, customer: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const made = await tx.insert(vanDayOrders).values({ companyId, dayId, visitId, orderId, kind, total: total.toFixed(2), createdBy: actor.id ?? 'system' }).onConflictDoNothing().returning({ id: vanDayOrders.id });
      if (made.length === 0) {
        // A sale whose payment was finished on a retry now has its total.
        if (total > 0) await tx.update(vanDayOrders).set({ total: total.toFixed(2) }).where(and(eq(vanDayOrders.orderId, orderId), eq(vanDayOrders.total, '0.00')));
        return;
      }
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, kind === 'order' ? 'day.order_taken' : 'day.sale_made', { detail: { order: number, kind, total, customer } });
    });
  }

  /** The day's sales and what they came to, by how they were paid. */
  async forDay(companyId: string, dayId: string): Promise<DaySales> {
    if (!isId(dayId)) return { rows: [], totals: { all: 0, cash: 0, mobileMoney: 0, card: 0, credit: 0 }, ordered: 0 };
    const rows = await this.db
      .select({ l: vanDayOrders, number: orders.orderNumber, customer: orders.customerName })
      .from(vanDayOrders)
      .innerJoin(orders, eq(orders.id, vanDayOrders.orderId))
      .where(and(eq(vanDayOrders.companyId, companyId), eq(vanDayOrders.dayId, dayId)))
      .orderBy(asc(vanDayOrders.createdAt), asc(vanDayOrders.id))
      .limit(500);
    const taken = await this.db
      .select({ kind: orderTenders.methodKind, n: sql<string>`COALESCE(SUM(${orderTenders.amount}), 0)::text` })
      .from(orderTenders)
      .innerJoin(vanDayOrders, eq(vanDayOrders.orderId, orderTenders.orderId))
      .where(and(eq(vanDayOrders.dayId, dayId), eq(orderTenders.kind, 'payment_method')))
      .groupBy(orderTenders.methodKind);
    const by = (k: string) => Number(taken.find((t) => t.kind === k)?.n ?? 0);
    const credit = rows.filter((r) => r.l.kind === 'credit').reduce((n, r) => n + Number(r.l.total), 0);
    const ordered = rows.filter((r) => r.l.kind === 'order').reduce((n, r) => n + Number(r.l.total), 0);
    const round = (n: number) => Math.round(n * 100) / 100;
    const totals = { cash: round(by('cash')), mobileMoney: round(by('mobile_money')), card: round(by('card')), credit: round(credit) };
    return {
      rows: rows.map((r) => ({ orderId: r.l.orderId, orderNumber: r.number, customerName: r.customer, kind: rowKind(r.l.kind), total: Number(r.l.total), at: r.l.createdAt.toISOString(), visitId: r.l.visitId })),
      totals: { ...totals, all: round(totals.cash + totals.mobileMoney + totals.card + totals.credit) },
      ordered: round(ordered),
    };
  }
}
