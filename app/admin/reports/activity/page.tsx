import type { Metadata } from 'next';
import { requirePermission } from '@/server/domains/access-control/guard';
import { listReportAuditAction } from '@/server/domains/reports/actions';
import { businessTimeZone } from '@/server/kernel/numbering/business-date';
import { ReportActivity } from '@/components/reports/hub/ReportActivity';

export const metadata: Metadata = { title: 'Report activity' };

export default async function ReportActivityPage() {
  await requirePermission('reports:view_audit');
  return <ReportActivity listPromise={listReportAuditAction({})} timeZone={businessTimeZone()} />;
}
