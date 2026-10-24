import { Suspense } from 'react';
import { bankChangesAction } from '@/server/domains/vendors/admin-actions';
import { BankChangesClient } from '@/components/admin/vendors/BankChangesClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = bankChangesAction();
  return (
    <Suspense fallback={<PageSkeleton label="bank changes" />}>
      <BankChangesClient initialPromise={initial} />
    </Suspense>
  );
}
