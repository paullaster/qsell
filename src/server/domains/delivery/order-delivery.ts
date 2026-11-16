import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, orderDeliveries, orders, type OrderDeliveryRow } from '@/server/db/drizzle/schema';
import { choiceWords } from '@/lib/branch-choice';
import { orderReadinessProblem } from './order-readiness';
import type { DeliveryMethod } from '@/lib/delivery-methods';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { PlanResult } from './plan';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type Planned = Extract<PlanResult, { ok: true }>;

/** The delivery an order was given: which branch, why, where to, and the charge quoted with its working. Written once, with the order. */
export class OrderDeliveries {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  /** Saves the plan on the order, in the order's own transaction, and notes the branch choice in the decision log. */
  async record(
    tx: Tx,
    input: {
      companyId: string;
      orderId: string;
      method: DeliveryMethod;
      plan: Planned;
      currency: string;
      recipient?: { name: string; phone: string } | null;
      notes?: string | null;
      actor: { type: 'user' | 'system'; id: string | null };
    },
  ): Promise<void> {
    const { plan } = input;
    await tx.insert(orderDeliveries).values({
      orderId: input.orderId,
      companyId: input.companyId,
      method: input.method,
      branchId: plan.branch.id,
      destination: plan.destination,
      choice: plan.choice,
      charge: {
        amount: plan.quote.amount,
        split: plan.quote.split,
        taxRate: plan.quote.taxRate,
        currency: plan.quote.currency,
        policy: plan.quote.policy,
        zone: plan.quote.zone,
        route: plan.quote.route,
        steps: plan.quote.steps,
      },
      chargeAmount: plan.quote.split.gross.toFixed(2),
      chargeNet: plan.quote.split.net.toFixed(2),
      chargeTax: plan.quote.split.tax.toFixed(2),
      taxRate: String(plan.quote.taxRate),
      recipientName: input.recipient?.name ?? null,
      recipientPhone: input.recipient?.phone ?? null,
      notes: input.notes ?? null,
      currency: input.currency,
    });
    await this.decisions.record(
      {
        companyId: input.companyId,
        subject: { type: 'order', id: input.orderId },
        action: 'delivery.branch_chosen',
        actor: input.actor,
        to: plan.branch.code,
        reason: { code: plan.choice.reason, text: plan.choice.words },
        ...(plan.quote.policy === null ? {} : { policy: { id: plan.quote.policy.id, version: String(plan.quote.policy.version) } }),
        inputs: {
          method: input.method,
          positionFrom: plan.destination.positionFrom,
          considered: plan.choice.ranked.map((r) => r.code),
        },
        outcome: {
          charge: plan.quote.split.gross,
          tax: plan.quote.split.tax,
          currency: plan.quote.currency,
        },
      },
      tx,
    );
  }

  /**
   * Plans the delivery of an order that was taken by staff, or converted from a quote, and so never went through the shop's checkout. The
   * order already has its branch and the delivery charge that was agreed when it was taken, so nothing is chosen or quoted again: the
   * delivery goes from the order's branch, to the place written here, for the charge already on the order. After this the order is
   * delivered like any other (deliveries are made, packed, sent and proved on their own screens).
   */
  async planStaffOrder(
    actor: { companyId: string; userId: string },
    orderId: string,
    input: { method: unknown; county?: unknown; town?: unknown; area?: unknown; recipientName?: unknown; recipientPhone?: unknown; notes?: unknown },
  ): Promise<{ ok: true; branchName: string } | { ok: false; reason: 'not_found' | 'not_allowed' | 'bad_input'; message: string }> {
    const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);
    const method = input.method === 'own_fleet' || input.method === 'courier' ? input.method : null;
    if (method === null) return { ok: false, reason: 'bad_input', message: 'Choose how it is delivered: by your own riders or by a courier.' };
    const county = text(input.county, 120);
    const town = text(input.town, 120);
    const area = text(input.area, 120);
    if (county === null && town === null && area === null) return { ok: false, reason: 'bad_input', message: 'Write the town or area it goes to, so the rider and the dispatch board know where it is.' };
    const recipientName = text(input.recipientName, 120);
    const recipientPhone = text(input.recipientPhone, 40);
    if ((recipientName === null) !== (recipientPhone === null)) return { ok: false, reason: 'bad_input', message: 'Give both the name and the phone of the person who receives it, or neither.' };

    return await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus, paymentMethod: orders.paymentMethod, branchId: orders.branchId, shippingFee: orders.shippingFee, currency: orders.currency })
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update');
      if (order === undefined) return { ok: false as const, reason: 'not_found' as const, message: 'That order could not be found.' };
      if (orderReadinessProblem(order)?.reason === 'order_closed') return { ok: false as const, reason: 'not_allowed' as const, message: 'This order was cancelled or refunded.' };
      const [had] = await tx.select({ orderId: orderDeliveries.orderId }).from(orderDeliveries).where(eq(orderDeliveries.orderId, orderId));
      if (had !== undefined) return { ok: false as const, reason: 'not_allowed' as const, message: 'This order already has its delivery planned.' };
      const [branch] = order.branchId === null ? [] : await tx.select({ id: branches.id, code: branches.code, name: branches.name }).from(branches).where(and(eq(branches.id, order.branchId), eq(branches.companyId, actor.companyId), eq(branches.isActive, true)));
      if (branch === undefined) return { ok: false as const, reason: 'not_allowed' as const, message: 'This order has no active branch to send the goods from. Give the order a branch first.' };

      const fee = Number(order.shippingFee);
      const chosen = { branchId: branch.id, code: branch.code, name: branch.name, km: null, minutes: null, coversLines: 0, totalLines: 0 };
      const choice = {
        reason: 'staff_chose' as const,
        words: choiceWords({ chosen: { ...chosen, coversUnits: 0, totalUnits: 0, offersMethod: true }, reason: 'staff_chose', ranked: [], excluded: [], passedOver: [], partial: false }),
        chosen,
        ranked: [],
        excluded: [],
        passedOver: [],
        partial: false,
        provider: 'none',
        degraded: false,
      };
      await tx.insert(orderDeliveries).values({
        orderId,
        companyId: actor.companyId,
        method,
        branchId: branch.id,
        destination: { pin: null, address: { county, town, area }, positionFrom: 'none', approximate: false },
        choice,
        charge: {
          amount: fee,
          split: { net: fee, tax: 0, gross: fee },
          taxRate: 0,
          currency: order.currency,
          policy: null,
          zone: null,
          route: null,
          steps: [{ label: 'The delivery charge on the order, as agreed when it was taken', amount: fee }],
        },
        chargeAmount: fee.toFixed(2),
        chargeNet: fee.toFixed(2),
        chargeTax: '0.00',
        taxRate: '0',
        recipientName,
        recipientPhone,
        notes: text(input.notes, 300),
        currency: order.currency,
      });
      await this.decisions.record(
        {
          companyId: actor.companyId,
          subject: { type: 'order', id: orderId },
          action: 'delivery.planned_by_staff',
          actor: { type: 'user', id: actor.userId },
          to: branch.code,
          reason: { code: 'staff_chose', text: choice.words },
          inputs: { method, county, town, area },
          outcome: { charge: fee, currency: order.currency },
        },
        tx,
      );
      return { ok: true as const, branchName: branch.name };
    });
  }

  async forOrder(companyId: string, orderId: string): Promise<OrderDeliveryRow | null> {
    const [row] = await this.db
      .select()
      .from(orderDeliveries)
      .where(and(eq(orderDeliveries.orderId, orderId), eq(orderDeliveries.companyId, companyId)));
    return row ?? null;
  }
}
