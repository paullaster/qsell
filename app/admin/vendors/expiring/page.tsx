import { Suspense } from 'react';
import { expiringDocumentsAction } from '@/server/domains/vendors/admin-actions';
import { ExpiringDocumentsClient } from '@/components/admin/vendors/ExpiringDocumentsClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = expiringDocumentsAction({ withinDays: 60 });
  return (
    <Suspense fallback={<PageSkeleton label="expiring documents" />}>
      <ExpiringDocumentsClient initialPromise={initial} />
    </Suspense>
  );
}
