import { Suspense } from 'react';
import { vendorCertificatesAction } from '@/server/domains/vendors/payment-portal-actions';
import { VendorCertificatesClient } from '@/components/vendor/VendorCertificatesClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = vendorCertificatesAction();
  return (
    <Suspense fallback={<PageSkeleton label="your certificates" />}>
      <VendorCertificatesClient initialPromise={initial} />
    </Suspense>
  );
}
