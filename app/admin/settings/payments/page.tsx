import {
  listPaymentConfigsAction,
  listBranchesAction,
} from '@/server/domains/payments/actions';
import { PAYMENT_PROVIDER_META, type PaymentProviderCode } from '@/server/domains/payments/types';
import { getContainer } from '@/server/di/container';
import { AdminPaymentsHubClient } from '@/components/admin/settings/AdminPaymentsHubClient';

export default async function AdminSettingsPaymentsHubPage() {
  const company = await getContainer().companySettings.ensureSeeded();

  return (
    <AdminPaymentsHubClient
      branchesPromise={listBranchesAction()}
      configsPromise={listPaymentConfigsAction()}
      publicBaseUrl={company.publicBaseUrl}
      providers={Object.keys(PAYMENT_PROVIDER_META) as PaymentProviderCode[]}
    />
  );
}
