import { Suspense } from 'react';
import { documentTypesAction } from '@/server/domains/vendors/admin-actions';
import { DocumentTypesClient } from '@/components/admin/vendors/DocumentTypesClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = documentTypesAction();
  return (
    <Suspense fallback={<PageSkeleton label="document types" />}>
      <DocumentTypesClient initialPromise={initial} />
    </Suspense>
  );
}
