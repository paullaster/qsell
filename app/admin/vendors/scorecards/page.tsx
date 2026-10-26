import { Suspense } from 'react';
import { scorecardsAction } from '@/server/domains/vendors/scorecard-actions';
import { ScorecardClient } from '@/components/admin/vendors/ScorecardClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = scorecardsAction();
  return (
    <Suspense fallback={<PageSkeleton label="the scorecard" />}>
      <ScorecardClient initialPromise={initial} />
    </Suspense>
  );
}
