import { getLimitsPageAction } from '@/server/domains/pricing/guard-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { LimitsClient } from '@/components/admin/pricing/LimitsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminOverrideLimitsPage() {
  const [data, canManage] = await Promise.all([
    getLimitsPageAction(),
    canPermission('pricing:manage'),
  ]);
  if (!data.ok) return <ErrorNote message={data.error} />;
  return <LimitsClient limits={data.data.limits} roles={data.data.roles} canManage={canManage} />;
}
