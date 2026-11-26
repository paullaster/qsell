import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { ReportHeadingClient } from '@/components/admin/settings/reports/ReportHeadingClient';
import { reportPrintScreenAction } from '@/server/domains/company/print-branding-actions';

export const metadata: Metadata = { title: 'Report headings' };

export default function ReportHeadingSettingsPage() {
  const first = reportPrintScreenAction();
  return (
    <SettingsFrame label="report heading settings">
      <ReportHeadingClient firstPromise={first} moduleCode={null} />
    </SettingsFrame>
  );
}
