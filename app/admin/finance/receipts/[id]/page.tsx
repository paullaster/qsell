import { receiptDetailAction } from '@/server/domains/finance/receivables/actions';
import { ReceiptDetailClient } from '@/components/admin/finance/ReceiptDetailClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ posting_failed?: string }> }) {
  const view = params.then(({ id }) => receiptDetailAction(id));
  const postingFailed = searchParams.then((query) => query.posting_failed);
  return (
    <FinancePage label="the receipt">
      <ReceiptDetailClient viewPromise={view} postingFailedPromise={postingFailed} />
    </FinancePage>
  );
}
