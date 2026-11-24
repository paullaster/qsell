import { Suspense } from 'react';
import { requirePermission } from '@/server/domains/access-control/guard';
import { getBusinessOverviewAction } from '@/server/domains/reports/actions';
import { BusinessOverviewView } from '@/components/admin/overview/BusinessOverviewView';
import { PanelSkeleton } from '@/components/reports/kit/Panel';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function AdminDashboardPage({ searchParams }: { searchParams: SearchParams }) {
  // Whether this person may see the overview is decided here, once. The figures themselves stream in behind the page.
  await requirePermission('dashboard:read');
  const params = await searchParams;
  return (
    <Suspense
      fallback={
        <div className="space-y-4 p-3 sm:p-5">
          <PanelSkeleton label="the business overview" rows={3} />
          <PanelSkeleton label="sales" rows={2} />
        </div>
      }
    >
      <Overview params={params} />
    </Suspense>
  );
}

async function Overview({ params }: { params: Record<string, string | string[] | undefined> }) {
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
