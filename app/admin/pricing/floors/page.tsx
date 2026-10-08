import { getFloorsPageAction } from '@/server/domains/pricing/guard-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { FloorsClient } from '@/components/admin/pricing/FloorsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminPriceFloorsPage() {
  const [data, canManage] = await Promise.all([
    getFloorsPageAction(),
    canPermission('pricing:manage'),
  ]);
  if (!data.ok) return <ErrorNote message={data.error} />;
  return <FloorsClient data={data.data} canManage={canManage} />;
}
