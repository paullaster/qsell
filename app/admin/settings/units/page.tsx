import type { Metadata } from 'next';
import { unitsPageAction } from '@/server/domains/units/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { AdminUnitsClient } from '@/components/admin/settings/AdminUnitsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Units of measure' };

export default function AdminUnitsPage() {
  // Both start now and run side by side; the screen's frame shows at once.
  const firstPage = unitsPageAction({});
  const canManage = canPermission('units:manage');
  return (
    <SettingsFrame label="units of measure">
      <AdminUnitsClient firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
