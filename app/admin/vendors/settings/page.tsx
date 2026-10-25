import { Suspense } from 'react';
import { vendorSettingsAction } from '@/server/domains/vendors/po-actions';
import { PoSettingsClient } from '@/components/admin/vendors/PoSettingsClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = vendorSettingsAction();
  return (
    <Suspense fallback={<PageSkeleton label="ordering rules" />}>
      <PoSettingsClient initialPromise={initial} />
    </Suspense>
  );
}
