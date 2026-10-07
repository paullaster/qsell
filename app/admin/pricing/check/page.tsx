import { getPricingLookupsAction } from '@/server/domains/pricing/actions';
import { PriceCheckClient } from '@/components/admin/pricing/PriceCheckClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminPriceCheckPage() {
  const lookups = await getPricingLookupsAction();
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <PriceCheckClient lookups={lookups.data} />;
}
