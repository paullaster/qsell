import type { Metadata } from 'next';
import { requirePermission } from '@/server/domains/access-control/guard';
import { listReportsAction } from '@/server/domains/reports/actions';
import { ReportsHub } from '@/components/reports/hub/ReportsHub';

export const metadata: Metadata = { title: 'Reports' };

export default async function ReportsPage() {
  // Whether this person may open the hub is decided here, once. The list itself streams in behind the page.
  await requirePermission('reports:read');
  return <ReportsHub listPromise={listReportsAction()} />;
}
