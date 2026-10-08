import { getDiscountLookupsAction } from '@/server/domains/pricing/discount-actions';
import { getRebateAction } from '@/server/domains/pricing/retrospective-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { RebateDetailClient } from '@/components/admin/pricing/RebateDetailClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function RebateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, lookups, canManage] = await Promise.all([
    getRebateAction(id),
    getDiscountLookupsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!detail.ok) return <ErrorNote message={detail.error} />;
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <RebateDetailClient detail={detail.data} lookups={lookups.data} canManage={canManage} />;
}
