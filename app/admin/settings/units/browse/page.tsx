import type { Metadata } from 'next';
import { unitsPageAction } from '@/server/domains/units/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { AdminUnitsClient } from '@/components/admin/settings/AdminUnitsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'All units of measure' };

/** The whole list on its own address, so a product form can offer "View all" without leaving the form (see the intercepted copy). */
export default function BrowseUnitsPage() {
  return (
    <SettingsFrame label="units of measure">
      <AdminUnitsClient firstPage={unitsPageAction({})} canManage={canPermission('units:manage')} />
    </SettingsFrame>
  );
}
