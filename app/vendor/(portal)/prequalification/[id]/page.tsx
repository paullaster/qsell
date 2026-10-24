import { Suspense } from 'react';
import { prequalEntryAction } from '@/server/domains/vendors/prequal-portal-actions';
import { PrequalEntryClient } from '@/components/vendor/PrequalEntryClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorPrequalificationEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const entry = params.then(({ id }) => prequalEntryAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="your application" />}>
      <PrequalEntryClient entryPromise={entry} />
    </Suspense>
  );
}
