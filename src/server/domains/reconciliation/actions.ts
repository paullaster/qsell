'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { ReconciliationEngine } from './service';
import type { ReconciliationLog } from '@/types/index';

export async function listReconciliationLogsAction(limit = 50): Promise<ReconciliationLog[]> {
  await requirePermission('transactions:read');
  return ReconciliationEngine.getReconciliationLogs(limit);
}

export async function runBatchReconciliationAction() {
  await requirePermission('transactions:reconcile');
  const result = ReconciliationEngine.runBatchReconciliation();
  revalidatePath('/admin/reconciliation');
  revalidatePath('/admin');
  return result;
}

export async function resolveDiscrepancyAction(
  logId: string,
  action: 'force_match' | 'mark_refund_required' | 'cancel_order',
  notes: string,
) {
  await requirePermission('transactions:reconcile');
  const log = ReconciliationEngine.resolveDiscrepancy(logId, action, notes);
  revalidatePath('/admin/reconciliation');
  revalidatePath('/admin/orders');
  return log;
}
