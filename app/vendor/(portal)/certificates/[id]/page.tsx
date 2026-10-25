import { Suspense } from 'react';
import { vendorCertificateAction } from '@/server/domains/vendors/payment-portal-actions';
import { CertificateDocument } from '@/components/shared/CertificateDocument';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => vendorCertificateAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the certificate" />}>
      <CertificateDocument viewPromise={view} backHref="/vendor/certificates" />
    </Suspense>
  );
}
