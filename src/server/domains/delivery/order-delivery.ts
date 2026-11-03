import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { orderDeliveries, type OrderDeliveryRow } from '@/server/db/drizzle/schema';
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

  async forOrder(companyId: string, orderId: string): Promise<OrderDeliveryRow | null> {
    const [row] = await this.db
      .select()
      .from(orderDeliveries)
      .where(and(eq(orderDeliveries.orderId, orderId), eq(orderDeliveries.companyId, companyId)));
    return row ?? null;
  }
}
