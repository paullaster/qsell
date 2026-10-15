import { Suspense } from 'react';
import { paymentSetupAction } from '@/server/domains/finance/payment-setup-actions';
import { PaymentSetupClient } from '@/components/admin/settings/PaymentSetupClient';
import { PageSkeleton } from '@/components/admin/finance/ui';

// The page itself decides nothing: the action checks the permission, and the data streams in.
export default function AdminSettingsPaymentsPage() {
  return (
    <Suspense fallback={<PageSkeleton label="payment settings" />}>
      <PaymentSetupClient setupPromise={paymentSetupAction()} />
    </Suspense>
  );
}
