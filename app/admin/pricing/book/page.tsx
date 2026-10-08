import { getDiscountLookupsAction } from '@/server/domains/pricing/discount-actions';
import { PriceBookClient } from '@/components/admin/pricing/PriceBookClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminPriceBookPage() {
  const lookups = await getDiscountLookupsAction();
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <PriceBookClient lookups={lookups.data} />;
}
