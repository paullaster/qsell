import { getWeightsAction } from '@/server/domains/pricing/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { RulesClient } from '@/components/admin/pricing/RulesClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminPriceRulesPage() {
  const [weights, canManage] = await Promise.all([
    getWeightsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!weights.ok) return <ErrorNote message={weights.error} />;
  return <RulesClient weights={weights.data} canManage={canManage} />;
}
