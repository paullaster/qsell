import { getDiscountLookupsAction } from '@/server/domains/pricing/discount-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { NewRebateClient } from '@/components/admin/pricing/NewRebateClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function NewRebatePage() {
  const [lookups, canManage] = await Promise.all([
    getDiscountLookupsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  if (!canManage)
    return <ErrorNote message="You do not have permission to make rebate programmes." />;
  return <NewRebateClient lookups={lookups.data} />;
}
