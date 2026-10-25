import { Suspense } from 'react';
import { vendorDetailAction } from '@/server/domains/vendors/actions';
import { vendorReviewAction } from '@/server/domains/vendors/review-actions';
import { vendorTermsAction } from '@/server/domains/vendors/payment-terms-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { VendorTermsPanel } from '@/components/admin/vendors/VendorTermsPanel';
import { VendorDetailClient } from '@/components/admin/vendors/VendorDetailClient';
import { VendorReviewSection } from '@/components/admin/vendors/VendorReviewPanel';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  // Both start now and run side by side; the card shows as soon as it has its own data.
  const view = params.then(({ id }) => vendorDetailAction(id));
  const review = params.then(({ id }) => vendorReviewAction(id));
  const idOf = params.then(({ id }) => id);
  const terms = params.then(({ id }) => vendorTermsAction(id));
  const canEditTerms = canPermission('vendor_payments:manage_terms');
  return (
    <Suspense fallback={<PageSkeleton label="the vendor" />}>
      <MissingAs404 result={view}>
        <VendorDetailClient viewPromise={view} reviewSlot={<ReviewSlot idPromise={idOf} reviewPromise={review} />} termsSlot={<TermsSlot idPromise={idOf} termsPromise={terms} canEditPromise={canEditTerms} />} />
      </MissingAs404>
    </Suspense>
  );
}

async function ReviewSlot({ idPromise, reviewPromise }: { idPromise: Promise<string>; reviewPromise: ReturnType<typeof vendorReviewAction> }) {
  const id = await idPromise;
  return (
    <Suspense fallback={<PageSkeleton label="the application" />}>
      <VendorReviewSection vendorId={id} reviewPromise={reviewPromise} />
    </Suspense>
  );
}

async function TermsSlot({ idPromise, termsPromise, canEditPromise }: { idPromise: Promise<string>; termsPromise: ReturnType<typeof vendorTermsAction>; canEditPromise: Promise<boolean> }) {
  const [id, canEdit] = await Promise.all([idPromise, canEditPromise]);
  return (
    <Suspense fallback={<PageSkeleton label="how this vendor is paid" />}>
      <VendorTermsPanel vendorId={id} termsPromise={termsPromise} canEdit={canEdit} />
    </Suspense>
  );
}
