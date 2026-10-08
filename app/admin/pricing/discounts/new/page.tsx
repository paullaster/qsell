import { getDiscountLookupsAction } from '@/server/domains/pricing/discount-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { NewDiscountClient } from '@/components/admin/pricing/NewDiscountClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function NewDiscountPage() {
  const [lookups, canManage] = await Promise.all([
    getDiscountLookupsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  if (!canManage) return <ErrorNote message="You do not have permission to make discount rules." />;
  return <NewDiscountClient lookups={lookups.data} />;
}
