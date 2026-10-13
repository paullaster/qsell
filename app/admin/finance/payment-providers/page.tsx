import { listProvidersAction } from '@/server/domains/finance/receivables/actions';
import { ProvidersClient } from '@/components/admin/finance/ProvidersClient';
import { LoadFailed } from '@/components/admin/finance/ui';

/** Provider connections do not depend on the chart of accounts, so no finance set-up gate here. */
export default async function AdminPaymentProvidersPage() {
  const res = await listProvidersAction();
  if (!res.ok) return <LoadFailed error={res.error} />;
  return <ProvidersClient view={res.data} />;
}
