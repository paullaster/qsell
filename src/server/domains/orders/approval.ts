import { eq } from 'drizzle-orm';
import { OrderStages } from './stages';
import type { OrderStage, StageOutcome } from '@/lib/order-stages';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { orderItems, orders } from '@/server/db/drizzle/schema';
import { guardLines } from '@/server/domains/pricing/guard-text';
import type { DocumentHandler } from '@/server/kernel/approvals/engine';
import { afterCommit } from '@/server/kernel/after-commit';
import { broadcastRealtime } from '@/server/realtime';

/** Sales channels whose orders are approved by staff. Shop checkouts and tills are never held up. */
export const APPROVED_SALES_MODULES = ['sales_order', 'credit_sale'] as const;

export function needsApprovalCheck(
  salesModule: string | undefined,
  requestedBy: string | undefined,
) {
  return (
    requestedBy !== undefined &&
    requestedBy !== '' &&
    (APPROVED_SALES_MODULES as readonly string[]).includes(salesModule ?? '')
  );
}

/** What an order's approvals do to the order itself. */
export function orderApprovalHandler(db: DrizzleDb): DocumentHandler {
  // What an approval decision does to the order is a stage, written by the stage writer in the approver's transaction.
  const setStatus =
    (status: 'approved' | 'rejected' | 'draft', stage: OrderStage, outcome: StageOutcome) =>
    async (orderId: string, tx: Parameters<DocumentHandler['onReleased']>[1]) => {
      await OrderStages.moveIn(tx, orderId, stage, outcome);
      afterCommit(
        tx,
        () => void broadcastRealtime('order_updated', { id: orderId, approvalStatus: status }),
      );
    };

  return {
    // The facts approvers were shown include the total: if it moves, the approval no longer applies.
    snapshot: async (orderId, tx) => {
      const [o] = await tx
        .select({ total: orders.totalAmount })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      return { amount: Number(o?.total ?? 0) };
    },
    onReleased: setStatus('approved', 'approval_approved', 'succeeded'),
    onRejected: setStatus('rejected', 'approval_rejected', 'failed'),
    // Reopened (or withdrawn): the order is editable again but still held until it is sent back.
    onReopened: setStatus('draft', 'approval_reopened', 'entered'),
    onCanceled: setStatus('draft', 'approval_withdrawn', 'cancelled'),
    describe: async (orderId) => {
      const [o] = await db
        .select({
          number: orders.orderNumber,
          name: orders.customerName,
          total: orders.totalAmount,
          currency: orders.currency,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!o) return null;
      const items = await db
        .select({ name: orderItems.productName, trace: orderItems.priceTrace })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));
      return {
        title: `Sales order ${o.number} for ${o.name}: ${o.currency} ${Number(o.total).toLocaleString('en-KE')}.`,
        lines: guardLines(items.map((i) => ({ name: i.name, guard: i.trace?.guard }))),
      };
    },
  };
}

/**
 * Sends a reopened order back for approval. The facts are rebuilt from the order and its customer
 * as they are now, so fixing the cause (a raised credit limit, say) is taken into account.
 */
export async function resubmitOrderForApproval(
  orderId: string,
  userId: string,
): Promise<'pending' | 'approved'> {
  const { getContainer } = await import('@/server/di/container');
  const { withAfterCommit } = await import('@/server/kernel/after-commit');
  const { customers: customersTable } = await import('@/server/db/drizzle/schema');
  const { drizzleDb } = await import('@/server/db/drizzle/client');
  const { orders: orderRepo, approvals, companySettings } = getContainer();

  const order = await orderRepo.getById(orderId);
  if (!order) throw new Error('Order not found.');
  if (order.approvalStatus !== 'draft') {
    throw new Error('This order is not waiting to be sent for approval again.');
  }
  const company = await companySettings.ensureSeeded();
  const [row] = await drizzleDb
    .select({ branchId: orders.branchId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  const [customer] = order.tradeCustomerId
    ? await drizzleDb
        .select()
        .from(customersTable)
        .where(eq(customersTable.id, order.tradeCustomerId))
        .limit(1)
    : [];
  // The order is already on the customer's balance, so the balance alone shows whether it is over.
  const overCreditLimit =
    customer !== undefined &&
    customer.accountType === 'credit' &&
    Number(customer.balance) > Number(customer.creditLimit);

  return withAfterCommit(drizzleDb, async (tx) => {
    const outcome = await approvals.submit(
      {
        companyId: company.id,
        trigger: 'sales_order.submitted',
        documentId: orderId,
        branchId: row?.branchId ?? null,
        requestedBy: userId,
        amount: Number(order.totalAmount),
        snapshot: {
          salesModule: order.salesModule,
          customer: {
            id: customer?.id ?? null,
            accountType: customer?.accountType ?? null,
            overCreditLimit,
            isBlocked: customer ? customer.blocked !== 'none' : false,
          },
        },
      },
      tx,
    );
    if (outcome.required && !outcome.released) {
      await OrderStages.moveIn(tx, orderId, 'approval_requested', 'entered', { source: 'staff', actor: { type: 'user', id: userId }, ref: { type: 'approval_request', id: `${orderId}:${order.updatedAt}` } });
      return 'pending' as const;
    }
    if (!outcome.required && overCreditLimit) {
      throw new Error(
        'This customer is over their credit limit and no approval workflow releases it.',
      );
    }
    // Nothing needs approving any more (or every step was skipped, which already approved it).
    await OrderStages.moveIn(tx, orderId, 'approval_approved', 'succeeded', { source: 'staff', actor: { type: 'user', id: userId }, message: 'Nothing needed approving any more.' });
    return 'approved' as const;
  });
}
