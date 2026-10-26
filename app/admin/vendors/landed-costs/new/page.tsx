import { Suspense } from 'react';
import { landedPreviewAction } from '@/server/domains/vendors/landed-cost-actions';
import { LandedCostEditorClient } from '@/components/admin/vendors/LandedCostEditorClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ searchParams }: { searchParams: Promise<{ rgn?: string }> }) {
  const view = searchParams.then(({ rgn }) => landedPreviewAction(typeof rgn === 'string' ? rgn : '', '', 'value'));
  return (
    <Suspense fallback={<PageSkeleton label="the charge" />}>
      <MissingAs404 result={view}>
        <LandedCostEditorClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
