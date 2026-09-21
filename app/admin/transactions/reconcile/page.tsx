import { AdminTransactionReconcile } from '@/components/admin/AdminTransactionReconcile';
import { getLedgerReconciliationSnapshotAction } from '@/server/domains/transactions/reconcile-actions';
import { listCallbackEventsRequiringReviewAction } from '@/server/domains/payments/classify-actions';

export const dynamic = 'force-dynamic';

export default async function AdminTransactionReconcilePage() {
  const [snapshot, callbacks] = await Promise.all([
    getLedgerReconciliationSnapshotAction(),
    listCallbackEventsRequiringReviewAction(50),
  ]);
  return (
    <AdminTransactionReconcile
      invoiceDebits={snapshot.invoiceDebits}
      paymentCredits={snapshot.paymentCredits}
      callbacks={callbacks}
    />
  );
}