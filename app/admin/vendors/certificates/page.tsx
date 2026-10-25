import { Suspense } from 'react';
import { certificatesAction } from '@/server/domains/vendors/payment-terms-actions';
import { CertificatesClient } from '@/components/admin/vendors/CertificatesClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = certificatesAction({});
  return (
    <Suspense fallback={<PageSkeleton label="withholding certificates" />}>
      <CertificatesClient initialPromise={initial} />
    </Suspense>
  );
}
