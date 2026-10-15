import { dimensionsPageAction } from '@/server/domains/dimensions/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { AdminDimensionsClient } from '@/components/admin/settings/AdminDimensionsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminDimensionsPage() {
  // Both start now and run side by side; the screen's frame shows at once.
  const firstPage = dimensionsPageAction({});
  const canManage = canPermission('dimensions:manage');
  return (
    <SettingsFrame label="dimensions">
      <AdminDimensionsClient firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
