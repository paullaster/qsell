import { listRefundFilesAction, refundFileCandidatesAction } from '@/server/domains/finance/refund-file-actions';
import { RefundFilesClient } from '@/components/admin/finance/RefundFilesClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const files = listRefundFilesAction();
  const candidates = refundFileCandidatesAction();
  return (
    <FinancePage label="bank payment files">
      <RefundFilesClient filesPromise={files} candidatesPromise={candidates} />
    </FinancePage>
  );
}
