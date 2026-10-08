import { listRebatesAction } from '@/server/domains/pricing/retrospective-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { RebatesClient } from '@/components/admin/pricing/RebatesClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminRebatesPage() {
  const [programs, canManage] = await Promise.all([
    listRebatesAction(),
    canPermission('pricing:manage'),
  ]);
  if (!programs.ok) return <ErrorNote message={programs.error} />;
  return <RebatesClient programs={programs.data} canManage={canManage} />;
}
