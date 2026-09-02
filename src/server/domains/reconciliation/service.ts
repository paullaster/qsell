import { db } from '@/server/db/store';
import type { TransactionRecord, Order, ReconciliationLog } from '@/types/index';

export class ReconciliationEngine {
  static reconcileSingleTransaction(
    transaction: TransactionRecord,
    order: Order,
    actor: string = 'auto_realtime'
  ): ReconciliationLog {
    const isSuccess = transaction.status === 'successful';
    const amountDifference = Number(transaction.amount) - Number(order.totalAmount);
    let discrepancyFound = false;
    let discrepancyType: 'none' | 'underpayment' | 'overpayment' | 'status_mismatch' | 'orphan_payment' =
      'none';
    let status: 'matched' | 'corrected' | 'flagged_for_review' = 'matched';
    let details = '';

    if (!isSuccess && order.paymentStatus === 'paid') {
      discrepancyFound = true;
      discrepancyType = 'status_mismatch';
      status = 'flagged_for_review';
      details = `Discrepancy: Order ${order.orderNumber} is marked as PAID but gateway transaction ${transaction.transactionReference} status is ${transaction.status}.`;
    } else if (Math.abs(amountDifference) > 0.01) {
      discrepancyFound = true;
      if (amountDifference < 0) {
        discrepancyType = 'underpayment';
        status = 'flagged_for_review';
        details = `Underpayment Alert: Order total is ${order.currency} ${order.totalAmount.toLocaleString()} but transaction captured only ${order.currency} ${transaction.amount.toLocaleString()}. Shortfall: ${Math.abs(amountDifference).toFixed(2)}`;
      } else {
        discrepancyType = 'overpayment';
        status = 'flagged_for_review';
        details = `Overpayment Notice: Order total is ${order.currency} ${order.totalAmount.toLocaleString()} but transaction captured ${order.currency} ${transaction.amount.toLocaleString()}. Excess: ${amountDifference.toFixed(2)}`;
      }
    } else {
      details = `Near Real-Time Reconciliation verified: Order ${order.orderNumber} total (${order.currency} ${order.totalAmount.toLocaleString()}) matches Gateway ${transaction.gatewayProvider} capture (${transaction.amount.toLocaleString()}). External Ref: ${transaction.externalReference || transaction.transactionReference}.`;
    }

    const log: ReconciliationLog = {
      id: `recon_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      transactionId: transaction.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      provider: transaction.gatewayProvider,
      reconciliationType: actor === 'auto_realtime' ? 'auto_realtime' : 'manual_override',
      orderTotal: order.totalAmount,
      receivedAmount: transaction.amount,
      discrepancyFound,
      discrepancyType,
      status,
      details,
      timestamp: new Date().toISOString(),
    };

    db.reconciliationLogs.unshift(log);
    transaction.reconciliationStatus = discrepancyFound ? 'discrepancy' : 'reconciled';
    transaction.updatedAt = new Date().toISOString();

    if (!discrepancyFound && order.paymentStatus === 'paid') {
      order.paymentStatus = 'reconciled';
      order.updatedAt = new Date().toISOString();
    }

    db.broadcast('reconciliation_event', {
      type: 'reconciliation_logged',
      log,
      orderId: order.id,
      discrepancyFound,
    });

    return log;
  }

  static runBatchReconciliation(): {
    totalChecked: number;
    matched: number;
    discrepancies: number;
    logs: ReconciliationLog[];
  } {
    let totalChecked = 0;
    let matched = 0;
    let discrepancies = 0;
    const newLogs: ReconciliationLog[] = [];

    const orders = Array.from(db.orders.values());
    const transactions = Array.from(db.transactions.values());

    for (const order of orders) {
      const txs = transactions.filter(
        (t) => t.orderId === order.id || t.orderNumber === order.orderNumber
      );
      if (txs.length === 0) {
        if (order.paymentStatus === 'paid') {
          const orphanLog: ReconciliationLog = {
            id: `recon_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            transactionId: 'unlinked',
            orderId: order.id,
            orderNumber: order.orderNumber,
            provider: order.paymentMethod,
            reconciliationType: 'scheduled_batch',
            orderTotal: order.totalAmount,
            receivedAmount: 0,
            discrepancyFound: true,
            discrepancyType: 'orphan_payment',
            status: 'flagged_for_review',
            details: `Orphan Warning: Order ${order.orderNumber} marked as paid but has no gateway transaction log.`,
            timestamp: new Date().toISOString(),
          };
          db.reconciliationLogs.unshift(orphanLog);
          newLogs.push(orphanLog);
          discrepancies++;
          totalChecked++;
        }
        continue;
      }

      for (const tx of txs) {
        totalChecked++;
        const log = this.reconcileSingleTransaction(tx, order, 'scheduled_batch');
        newLogs.push(log);
        if (log.discrepancyFound) discrepancies++;
        else matched++;
      }
    }

    db.broadcast('reconciliation_event', {
      type: 'batch_reconciliation_complete',
      totalChecked,
      matched,
      discrepancies,
    });

    return { totalChecked, matched, discrepancies, logs: newLogs };
  }

  static getReconciliationLogs(limit = 50): ReconciliationLog[] {
    return db.reconciliationLogs.slice(0, limit);
  }

  static resolveDiscrepancy(
    logId: string,
    resolutionAction: 'force_match' | 'mark_refund_required' | 'cancel_order',
    notes: string
  ): ReconciliationLog {
    const log = db.reconciliationLogs.find((l) => l.id === logId);
    if (!log) throw new Error(`Reconciliation log ${logId} not found`);

    const order = db.orders.get(log.orderId);
    log.status = 'corrected';
    log.details += ` | Resolved by Admin: [${resolutionAction}] - ${notes}`;

    if (order) {
      if (resolutionAction === 'force_match') {
        order.paymentStatus = 'reconciled';
        order.status = 'completed';
      } else if (resolutionAction === 'cancel_order') {
        order.status = 'cancelled';
        order.paymentStatus = 'failed';
        db.atomicReleaseReservation(
          order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
          order.id
        );
      }
      order.updatedAt = new Date().toISOString();
    }

    db.broadcast('reconciliation_event', {
      type: 'discrepancy_resolved',
      logId,
      resolutionAction,
    });

    return log;
  }
}
