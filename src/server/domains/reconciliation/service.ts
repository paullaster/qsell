import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { OrderStages } from '@/server/domains/orders/stages';
import { broadcastRealtime } from '@/server/realtime';
import { toReconciliationLog, toTransaction } from '@/server/domains/catalog/mappers';
import type { TransactionRecord, Order, ReconciliationLog } from '@/types/index';
import { amountDue } from '@/server/domains/orders/amount-due';

function newLogId(): string {
  return `recon_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

interface DiscrepancyVerdict {
  discrepancyFound: boolean;
  discrepancyType:
    | 'none'
    | 'underpayment'
    | 'overpayment'
    | 'status_mismatch'
    | 'orphan_payment';
  status: 'matched' | 'corrected' | 'flagged_for_review';
  details: string;
}

/**
 * Compares a gateway capture against its order and records the verdict.
 *
 * Every method here writes through the repositories, so a reconciliation is
 * durable and auditable rather than a transient in-memory mutation.
 */
export class ReconciliationEngine {
  private static verdict(transaction: TransactionRecord, order: Order): DiscrepancyVerdict {
    const isSuccess = transaction.status === 'successful';
    // What a gateway should have captured is the total less what gift cards or points covered.
    const amountDifference = Number(transaction.amount) - amountDue(order);

    if (!isSuccess && order.paymentStatus === 'paid') {
      return {
        discrepancyFound: true,
        discrepancyType: 'status_mismatch',
        status: 'flagged_for_review',
        details: `Discrepancy: Order ${order.orderNumber} is marked as PAID but gateway transaction ${transaction.transactionReference} status is ${transaction.status}.`,
      };
    }

    if (Math.abs(amountDifference) > 0.01) {
      if (amountDifference < 0) {
        return {
          discrepancyFound: true,
          discrepancyType: 'underpayment',
          status: 'flagged_for_review',
          details: `Underpayment Alert: Order total is ${order.currency} ${order.totalAmount.toLocaleString()} but transaction captured only ${order.currency} ${transaction.amount.toLocaleString()}. Shortfall: ${Math.abs(amountDifference).toFixed(2)}`,
        };
      }
      return {
        discrepancyFound: true,
        discrepancyType: 'overpayment',
        status: 'flagged_for_review',
        details: `Overpayment Notice: Order total is ${order.currency} ${order.totalAmount.toLocaleString()} but transaction captured ${order.currency} ${transaction.amount.toLocaleString()}. Excess: ${amountDifference.toFixed(2)}`,
      };
    }

    return {
      discrepancyFound: false,
      discrepancyType: 'none',
      status: 'matched',
      details: `Near Real-Time Reconciliation verified: Order ${order.orderNumber} total (${order.currency} ${order.totalAmount.toLocaleString()}) matches Gateway ${transaction.gatewayProvider} capture (${transaction.amount.toLocaleString()}). External Ref: ${transaction.externalReference || transaction.transactionReference}.`,
    };
  }

  static async reconcileSingleTransaction(
    transaction: TransactionRecord,
    order: Order,
    actor = 'auto_realtime',
  ): Promise<ReconciliationLog> {
    const container = getContainer();
    const verdict = this.verdict(transaction, order);

    const row = await container.paymentRecords.insertReconciliationLog({
      id: newLogId(),
      transactionId: transaction.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      provider: transaction.gatewayProvider,
      reconciliationType: actor === 'auto_realtime' ? 'auto_realtime' : 'manual_override',
      orderTotal: String(order.totalAmount),
      receivedAmount: String(transaction.amount),
      discrepancyFound: verdict.discrepancyFound,
      discrepancyType: verdict.discrepancyType,
      status: verdict.status,
      details: verdict.details,
    });
    const log = toReconciliationLog(row);

    await container.paymentRecords.updateTransaction(transaction.id, {
      reconciliationStatus: verdict.discrepancyFound ? 'discrepancy' : 'reconciled',
    });

    if (!verdict.discrepancyFound && order.paymentStatus === 'paid') {
      await OrderStages.move(drizzleDb, order.id, 'payment_reconciled', 'succeeded', {
        ref: { type: 'payment_transaction', id: transaction.id },
        detail: { actor, receivedAmount: String(transaction.amount) },
      });
    }

    void broadcastRealtime('reconciliation_event', {
      type: 'reconciliation_logged',
      log,
      orderId: order.id,
      discrepancyFound: verdict.discrepancyFound,
    });

    return log;
  }

  static async runBatchReconciliation(): Promise<{
    totalChecked: number;
    matched: number;
    discrepancies: number;
    logs: ReconciliationLog[];
  }> {
    const container = getContainer();
    let totalChecked = 0;
    let matched = 0;
    let discrepancies = 0;
    const newLogs: ReconciliationLog[] = [];

    const orders = await container.orders.listAll();
    const transactions = (await container.paymentRecords.listTransactions()).map(toTransaction);

    for (const order of orders) {
      const txs = transactions.filter(
        (t) => t.orderId === order.id || t.orderNumber === order.orderNumber,
      );
      if (txs.length === 0) {
        if (order.paymentStatus === 'paid') {
          const row = await container.paymentRecords.insertReconciliationLog({
            id: newLogId(),
            transactionId: 'unlinked',
            orderId: order.id,
            orderNumber: order.orderNumber,
            provider: order.paymentMethod,
            reconciliationType: 'scheduled_batch',
            orderTotal: String(order.totalAmount),
            receivedAmount: '0',
            discrepancyFound: true,
            discrepancyType: 'orphan_payment',
            status: 'flagged_for_review',
            details: `Orphan Warning: Order ${order.orderNumber} marked as paid but has no gateway transaction log.`,
          });
          const orphanLog = toReconciliationLog(row);
          newLogs.push(orphanLog);
          discrepancies++;
          totalChecked++;
        }
        continue;
      }

      for (const tx of txs) {
        totalChecked++;
        const log = await this.reconcileSingleTransaction(tx, order, 'scheduled_batch');
        newLogs.push(log);
        if (log.discrepancyFound) discrepancies++;
        else matched++;
      }
    }

    void broadcastRealtime('reconciliation_event', {
      type: 'batch_reconciliation_complete',
      totalChecked,
      matched,
      discrepancies,
    });

    return { totalChecked, matched, discrepancies, logs: newLogs };
  }

  static async getReconciliationLogs(limit = 50): Promise<ReconciliationLog[]> {
    const rows = await getContainer().paymentRecords.listReconciliationLogs();
    return rows.slice(0, limit).map(toReconciliationLog);
  }

  static async getReconciliationLogById(logId: string): Promise<ReconciliationLog | null> {
    const row = await getContainer().paymentRecords.getReconciliationLogById(logId);
    return row ? toReconciliationLog(row) : null;
  }

  static async resolveDiscrepancy(
    logId: string,
    resolutionAction: 'force_match' | 'mark_refund_required' | 'cancel_order',
    notes: string,
  ): Promise<ReconciliationLog> {
    const container = getContainer();
    const existing = await this.getReconciliationLogById(logId);
    if (!existing) throw new Error(`Reconciliation log ${logId} not found`);

    const details = `${existing.details} | Resolved by Admin: [${resolutionAction}] - ${notes}`;
    const row = await container.paymentRecords.updateReconciliationLog(logId, {
      status: 'corrected',
      details,
    });
    if (!row) throw new Error(`Reconciliation log ${logId} not found`);

    const order = await container.orders.getById(existing.orderId);
    if (order) {
      const ref = { type: 'reconciliation_log', id: logId };
      if (resolutionAction === 'force_match') {
        await drizzleDb.transaction(async (tx) => {
          await OrderStages.moveIn(tx, order.id, 'payment_reconciled', 'succeeded', { ref, source: 'staff', reasonCode: 'force_match', message: notes });
          await OrderStages.moveIn(tx, order.id, 'completed', 'succeeded', { ref, source: 'staff', reasonCode: 'force_match', message: notes });
        });
      } else if (resolutionAction === 'cancel_order') {
        await OrderStages.move(drizzleDb, order.id, 'cancelled', 'cancelled', { ref, source: 'staff', reasonCode: 'cancel_order', message: notes, set: { paymentStatus: 'failed' } });
        const { InventoryReservationService } = await import(
          '@/server/domains/inventory/reservation-service'
        );
        await InventoryReservationService.releaseOrder(
          order.id,
          'reconciliation_cancel_order',
          'reconciliation_admin',
        );
      }
    }

    void broadcastRealtime('reconciliation_event', {
      type: 'discrepancy_resolved',
      logId,
      resolutionAction,
    });

    return toReconciliationLog(row);
  }
}
