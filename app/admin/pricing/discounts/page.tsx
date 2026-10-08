import { listDiscountRulesAction } from '@/server/domains/pricing/discount-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { DiscountsClient } from '@/components/admin/pricing/DiscountsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminDiscountsPage() {
  const [rules, canManage] = await Promise.all([
    listDiscountRulesAction(),
    canPermission('pricing:manage'),
  ]);
  if (!rules.ok) return <ErrorNote message={rules.error} />;
  return <DiscountsClient rules={rules.data} canManage={canManage} />;
}
