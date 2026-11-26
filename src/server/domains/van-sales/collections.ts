import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customerReceipts, customers, vanDayCollections, vanVisits } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { CashSaleService } from '@/server/domains/selling/cash-sales/cash-sale-service';
import type { ShiftService } from '@/server/domains/selling/shifts/shift-service';
import type { FinanceServices } from '@/server/domains/finance';
import { FinanceError } from '@/server/domains/finance/errors';
import { collectProblem, goesIntoTill, readCollect } from '@/lib/van-sales/collect';
import { isId } from '@/lib/van-sales/people';
import { recordDayEvent } from './day-events';
import { VanSalesError } from './errors';
import { ownDay } from './own-day';

export interface OwingItem {
  documentNo: string;
  dueDate: string | null;
  remaining: number;
}

export interface OwingView {
  visitId: string;
  customerName: string;
  total: number;
  items: OwingItem[];
}

export interface CollectionView {
  id: string;
  visitId: string;
  customerName: string;
  receiptNumber: string;
  amount: number;
  methodKind: string;
  at: string;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Money a customer pays the rep at a visit against what they owe (docs/architecture/van-sales.md §7). The payment is an ordinary customer receipt,
 * posted and applied to the customer's open invoices oldest first, and counted in the day: cash goes into the van's till shift as a paid-in, mobile
 * money and card go to the company's account. A retry with the same key finds the receipt already made and never takes the money twice.
 */
export class VanCollectionService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly finance: Pick<FinanceServices, 'receipts' | 'customerLedger'>,
    private readonly shifts: ShiftService,
    private readonly cashSales: CashSaleService,
  ) {}

  /** What the customers at visits the rep has arrived at owe: the open invoices, oldest first. */
  async owing(companyId: string, dayId: string): Promise<OwingView[]> {
    if (!isId(dayId)) return [];
    const visits = await this.db.select({ id: vanVisits.id, customerId: vanVisits.customerId, name: customers.name }).from(vanVisits).innerJoin(customers, eq(customers.id, vanVisits.customerId)).where(and(eq(vanVisits.dayId, dayId), eq(vanVisits.status, 'arrived')));
    const out: OwingView[] = [];
    for (const v of visits) {
      const open = (await this.finance.customerLedger.openItems(companyId, v.customerId)).filter((e) => Number(e.remainingAmount) > 0);
      out.push({ visitId: v.id, customerName: v.name, total: round(open.reduce((n, e) => n + Number(e.remainingAmount), 0)), items: open.map((e) => ({ documentNo: e.documentNo, dueDate: e.dueDate?.toISOString().slice(0, 10) ?? null, remaining: Number(e.remainingAmount) })) });
    }
    return out;
  }

  /** The money collected on the day, in order. */
  async forDay(companyId: string, dayId: string): Promise<CollectionView[]> {
    if (!isId(dayId)) return [];
    const rows = await this.db
      .select({ c: vanDayCollections, number: customerReceipts.number, customer: customers.name })
      .from(vanDayCollections)
      .innerJoin(customerReceipts, eq(customerReceipts.id, vanDayCollections.receiptId))
      .innerJoin(vanVisits, eq(vanVisits.id, vanDayCollections.visitId))
      .innerJoin(customers, eq(customers.id, vanVisits.customerId))
      .where(and(eq(vanDayCollections.companyId, companyId), eq(vanDayCollections.dayId, dayId)))
      .orderBy(asc(vanDayCollections.createdAt), asc(vanDayCollections.id))
      .limit(500);
    return rows.map((r) => ({ id: r.c.id, visitId: r.c.visitId, customerName: r.customer, receiptNumber: r.number, amount: Number(r.c.amount), methodKind: r.c.methodKind, at: r.c.createdAt.toISOString() }));
  }

  /** Takes money from the customer the rep is at. */
  async collect(companyId: string, actor: Actor, dayId: string, raw: unknown, maySell: boolean): Promise<void> {
    const own = await ownDay(this.db, companyId, actor, dayId, maySell);
    const read = readCollect(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const c = read.collect;
    const [visit] = await this.db.select({ id: vanVisits.id, status: vanVisits.status, customerId: customers.id, name: customers.name }).from(vanVisits).innerJoin(customers, eq(customers.id, vanVisits.customerId)).where(and(eq(vanVisits.id, c.visitId), eq(vanVisits.dayId, dayId))).limit(1);
    if (visit === undefined) throw new VanSalesError('That visit could not be found on this day.');
    const method = (await this.cashSales.tenderMethods(companyId, own.d.branchId)).find((m) => m.id === c.methodId);
    if (method === undefined) throw new VanSalesError('That way of paying is not available here. Choose cash, M-Pesa or card.');
    if (method.requiresReference && c.reference === '') throw new VanSalesError(`${method.name} needs its reference (the M-Pesa code or the slip number).`);

    const [existing] = await this.db.select({ id: customerReceipts.id }).from(customerReceipts).where(and(eq(customerReceipts.companyId, companyId), eq(customerReceipts.idempotencyKey, `van-collect:${c.key}`)));
    const [done] = existing === undefined ? [] : await this.db.select({ id: vanDayCollections.id }).from(vanDayCollections).where(eq(vanDayCollections.receiptId, existing.id));
    if (done !== undefined) return;

    const owed = (await this.finance.customerLedger.netOwedCents(companyId, visit.customerId)) / 100;
    const problem = collectProblem({ dayStatus: own.d.status, visitStatus: visit.status, customerName: visit.name, owed, amount: c.amount });
    if (problem !== null) throw new VanSalesError(problem);
    const shiftId = own.d.shiftId;
    if (goesIntoTill(method.kind) && shiftId === null) throw new VanSalesError('The van\'s till is not open, so cash cannot be collected. Send the day out again, counting the float.');

    const ctx = { companyId, actor: { type: 'user' as const, id: actor.id ?? null }, origin: { surface: 'van_sales', action: 'collect' } };
    let receiptId: string;
    let receiptNumber: string;
    try {
      const made = await this.finance.receipts.create(ctx, { customerId: visit.customerId, paymentMethodId: method.id, amount: c.amount.toFixed(2), externalReference: c.reference === '' ? null : c.reference, payerName: visit.name, branchId: own.d.branchId, source: 'pos', narration: `Collected at a van visit (${visit.name})`, idempotencyKey: `van-collect:${c.key}` });
      receiptId = made.id;
      receiptNumber = made.number;
      const [state] = await this.db.select({ status: customerReceipts.status }).from(customerReceipts).where(eq(customerReceipts.id, receiptId));
      if (state?.status === 'draft') await this.finance.receipts.post(ctx, receiptId, { allocate: 'oldest_first' });
    } catch (error) {
      if (error instanceof FinanceError) throw new VanSalesError(error.message);
      throw error;
    }

    const link = async (tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0], movementId: string | null) => {
      const made = await tx.insert(vanDayCollections).values({ companyId, dayId, visitId: visit.id, receiptId, amount: c.amount.toFixed(2), methodKind: method.kind, movementId, createdBy: actor.id ?? 'system' }).onConflictDoNothing().returning({ id: vanDayCollections.id });
      if (made.length === 0) return;
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.collected', { detail: { receipt: receiptNumber, amount: c.amount, customer: visit.name, method: method.kind } });
    };
    if (goesIntoTill(method.kind) && shiftId !== null) {
      const moved = await this.shifts.moveLinked(companyId, { userId: actor.id ?? '', supervisor: false }, shiftId, { kind: 'paid_in', amount: c.amount, reason: `Collected from ${visit.name} (${receiptNumber})`.slice(0, 200) }, async (tx, movementId) => await link(tx, movementId));
      if (!moved.ok) throw new VanSalesError(moved.error);
    } else {
      await this.db.transaction(async (tx) => await link(tx, null));
    }
  }
}
