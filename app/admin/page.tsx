import { listAnalyticsAction } from '@/server/domains/analytics/actions';
import { AdminDashboardClient } from '@/components/admin/AdminDashboardClient';

export default async function AdminDashboardPage() {
  const analyticsPromise = listAnalyticsAction();
  return <AdminDashboardClient analyticsPromise={analyticsPromise} />;
}
