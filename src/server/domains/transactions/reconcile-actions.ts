'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import type {
  LedgerReconciliationSnapshot,
  MissingInvoiceDebit,
  MissingPaymentCredit,
} from './reconcile-service';

export type LedgerReconciliationSnapshotView = LedgerReconciliationSnapshot;

async function companyId(): Promise<string> {
  return (await getContainer().companySettings.ensureSeeded()).id;
}

function reconcile() {
  return getContainer().transactionReconcile;
}

/**
 * Manual-only view of documents that settled but never posted to the
 * transaction ledger. Nothing is retried automatically.
 */
export async function getLedgerReconciliationSnapshotAction(): Promise<LedgerReconciliationSnapshotView> {
  await requirePermission('transactions:read');
  return reconcile().listMissing(await companyId());
}

export async function postInvoiceLedgerDebitAction(orderId: string): Promise<MissingInvoiceDebit[]> {
  await requirePermission('transactions:post');
  await reconcile().postInvoiceDebit(await companyId(), orderId);
  revalidatePath('/admin/transactions/ledger');
  revalidatePath('/admin/transactions/reconcile');
  const snapshot = await getLedgerReconciliationSnapshotAction();
  return snapshot.invoiceDebits;
}

export async function postPaymentLedgerCreditAction(
  source: 'customer_ledger' | 'gateway_attempt',
  id: string,
): Promise<MissingPaymentCredit[]> {
  await requirePermission('transactions:post');
  await reconcile().postPaymentCredit(await companyId(), source, id);
  revalidatePath('/admin/transactions/ledger');
  revalidatePath('/admin/transactions/reconcile');
  const snapshot = await getLedgerReconciliationSnapshotAction();
  return snapshot.paymentCredits;
}