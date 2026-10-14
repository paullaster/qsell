import { paymentActivityAction } from '@/server/domains/payments/activity-actions';
import { PaymentActivityClient } from '@/components/admin/payments/PaymentActivityClient';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminPaymentActivityPage() {
  const res = await paymentActivityAction();
  if (!res.ok) return <LoadFailed error={res.error} />;
  return <PaymentActivityClient initial={res.data} />;
}
