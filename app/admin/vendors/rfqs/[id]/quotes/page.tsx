import { Suspense } from 'react';
import { rfqQuotesAction } from '@/server/domains/vendors/rfq-actions';
import { RfqQuotesClient } from '@/components/admin/vendors/RfqQuotesClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const idOf = params.then(({ id }) => id);
  const view = idOf.then((id) => rfqQuotesAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the quotes" />}>
      <MissingAs404 result={view}>
        <QuotesFor idPromise={idOf} viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}

async function QuotesFor({ idPromise, viewPromise }: { idPromise: Promise<string>; viewPromise: ReturnType<typeof rfqQuotesAction> }) {
  return <RfqQuotesClient rfqId={await idPromise} viewPromise={viewPromise} />;
}
