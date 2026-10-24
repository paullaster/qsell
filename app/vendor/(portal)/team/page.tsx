import { Suspense } from 'react';
import { teamAction } from '@/server/domains/vendors/portal-team-actions';
import { TeamClient } from '@/components/vendor/TeamClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorTeamPage() {
  const team = teamAction();
  return (
    <Suspense fallback={<PageSkeleton label="your team" />}>
      <TeamClient teamPromise={team} />
    </Suspense>
  );
}
