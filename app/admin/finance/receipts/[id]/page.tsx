import { receiptDetailAction } from '@/server/domains/finance/receivables/actions';
import { ReceiptDetailClient } from '@/components/admin/finance/ReceiptDetailClient';
import { FinancePage } from '@/components/admin/finance/gate';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ posting_failed?: string }> }) {
  const view = params.then(({ id }) => receiptDetailAction(id));
  const postingFailed = searchParams.then((query) => query.posting_failed);
  return (
    <FinancePage label="the receipt">
      <MissingAs404 result={view}>
        <ReceiptDetailClient viewPromise={view} postingFailedPromise={postingFailed} />
      </MissingAs404>
    </FinancePage>
  );
}
