import { Suspense } from 'react';
import { profileOverviewAction } from '@/server/domains/vendors/profile-actions';
import { ProfileOverviewClient } from '@/components/vendor/ProfileOverviewClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorProfilePage() {
  const overview = profileOverviewAction();
  return (
    <Suspense fallback={<PageSkeleton label="your profile" />}>
      <ProfileOverviewClient overviewPromise={overview} />
    </Suspense>
  );
}
