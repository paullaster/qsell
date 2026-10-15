import { numberSeriesPageAction } from '@/server/kernel/numbering/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { NumberSeriesListClient } from '@/components/admin/settings/numbering/NumberSeriesListClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminNumberSeriesPage() {
  const firstPage = numberSeriesPageAction({});
  const canManage = canPermission('numbering:manage');
  return (
    <SettingsFrame label="number series">
      <NumberSeriesListClient firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
