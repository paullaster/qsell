import { getPricingLookupsAction, listPriceListsAction } from '@/server/domains/pricing/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { PriceListsClient } from '@/components/admin/pricing/PriceListsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminPricingPage() {
  const [lists, lookups, canManage] = await Promise.all([
    listPriceListsAction(),
    getPricingLookupsAction(),
    canPermission('pricing:manage'),
  ]);
  if (!lists.ok) return <ErrorNote message={lists.error} />;
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <PriceListsClient lists={lists.data} lookups={lookups.data} canManage={canManage} />;
}
