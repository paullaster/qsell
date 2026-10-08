import { getDiscountLookupsAction } from '@/server/domains/pricing/discount-actions';
import { getInsightsAction } from '@/server/domains/pricing/insights-actions';
import { InsightsClient } from '@/components/admin/pricing/InsightsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminInsightsPage() {
  const [data, lookups] = await Promise.all([
    getInsightsAction({ days: 30 }),
    getDiscountLookupsAction(),
  ]);
  if (!data.ok) return <ErrorNote message={data.error} />;
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <InsightsClient initial={data.data} branches={lookups.data.branches} />;
}
