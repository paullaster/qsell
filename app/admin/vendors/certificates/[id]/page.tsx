import { Suspense } from 'react';
import { certificateAction } from '@/server/domains/vendors/payment-terms-actions';
import { CertificateDocument } from '@/components/shared/CertificateDocument';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => certificateAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the certificate" />}>
      <MissingAs404 result={view}>
        <CertificateDocument viewPromise={view} backHref="/admin/vendors/certificates" />
      </MissingAs404>
    </Suspense>
  );
}
