import { paymentSetupAction } from '@/server/domains/finance/payment-setup-actions';
import { PaymentSetupClient } from '@/components/admin/settings/PaymentSetupClient';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminSettingsPaymentsPage() {
  const res = await paymentSetupAction();
  if (!res.ok) return <LoadFailed error={res.error} />;
  return <PaymentSetupClient setup={res.data} />;
}
