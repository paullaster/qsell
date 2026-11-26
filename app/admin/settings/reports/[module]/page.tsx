import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { ReportHeadingClient } from '@/components/admin/settings/reports/ReportHeadingClient';
import { reportPrintScreenAction } from '@/server/domains/company/print-branding-actions';
import { reportModuleCodes } from '@/server/domains/reports/registry/modules';

export const metadata: Metadata = { title: 'Report headings' };

export default async function ReportModuleHeadingSettingsPage({
  params,
}: {
  params: Promise<{ module: string }>;
}) {
  const { module: code } = await params;
  if (!reportModuleCodes().includes(code)) notFound();
  const first = reportPrintScreenAction();
  return (
    <SettingsFrame label="report heading settings">
      <ReportHeadingClient firstPromise={first} moduleCode={code} />
    </SettingsFrame>
  );
}
