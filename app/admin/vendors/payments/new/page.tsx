import { Suspense } from 'react';
import { paymentAction } from '@/server/domains/vendors/payment-actions';
import { PaymentVoucherClient } from '@/components/admin/vendors/PaymentVoucherClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page({ searchParams }: { searchParams: Promise<{ invoice?: string }> }) {
  const view = searchParams.then(({ invoice }) => paymentAction(null, typeof invoice === 'string' ? invoice : null));
  return (
    <Suspense fallback={<PageSkeleton label="the payment" />}>
      <PaymentVoucherClient viewPromise={view} />
    </Suspense>
  );
}
