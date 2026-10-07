import { notFound } from 'next/navigation';
import { getPriceListAction, getPricingLookupsAction } from '@/server/domains/pricing/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { PriceListDetailClient } from '@/components/admin/pricing/PriceListDetailClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminPriceListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, lookups, canManage] = await Promise.all([
    getPriceListAction(id),
    getPricingLookupsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!detail.ok) {
    if (detail.code === 'NOT_FOUND') notFound();
    return <ErrorNote message={detail.error} />;
  }
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return (
    <PriceListDetailClient detail={detail.data} lookups={lookups.data} canManage={canManage} />
  );
}
