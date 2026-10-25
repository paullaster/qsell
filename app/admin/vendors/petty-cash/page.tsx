import { Suspense } from 'react';
import { pettyFloatsAction } from '@/server/domains/vendors/petty-cash-actions';
import { PettyFloatsClient } from '@/components/admin/vendors/PettyFloatsClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = pettyFloatsAction();
  return (
    <Suspense fallback={<PageSkeleton label="petty cash" />}>
      <PettyFloatsClient initialPromise={initial} />
    </Suspense>
  );
}
