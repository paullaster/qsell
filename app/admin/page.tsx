import { getBusinessOverviewAction } from '@/server/domains/reports/actions';
import { BusinessOverviewView } from '@/components/admin/overview/BusinessOverviewView';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function AdminDashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const data = await getBusinessOverviewAction({
    preset: first(params.period),
    compare: first(params.compare),
    from: first(params.from),
    to: first(params.to),
    branchId: first(params.branch),
  });
  // The branch that was actually applied (an unknown or disallowed id is ignored server-side).
  return <BusinessOverviewView data={data} selectedBranchId={data.meta.scope.branchId ?? ''} />;
}
