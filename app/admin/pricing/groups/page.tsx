import { listCustomerGroupsAction } from '@/server/domains/pricing/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { GroupsClient } from '@/components/admin/pricing/GroupsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminCustomerGroupsPage() {
  const [groups, canManage] = await Promise.all([
    listCustomerGroupsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!groups.ok) return <ErrorNote message={groups.error} />;
  return <GroupsClient groups={groups.data} canManage={canManage} />;
}
