import { getLoyaltyAction } from '@/server/domains/pricing/retrospective-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { LoyaltyClient } from '@/components/admin/pricing/LoyaltyClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminLoyaltyPage() {
  const [program, canManage] = await Promise.all([
    getLoyaltyAction(),
    canPermission('pricing:manage'),
  ]);
  if (!program.ok) return <ErrorNote message={program.error} />;
  return <LoyaltyClient program={program.data} canManage={canManage} />;
}
