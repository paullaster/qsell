import type { Metadata } from 'next';
import { geoSettingsPageAction } from '@/server/domains/geo/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { DeliveryMapsClient } from '@/components/admin/delivery/DeliveryMapsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Map service' };

export default function DeliveryMapsPage() {
  const data = geoSettingsPageAction();
  const canManage = canPermission('deliveries:manage');
  return (
    <SettingsFrame label="map service">
      <DeliveryMapsClient data={data} canManage={canManage} />
    </SettingsFrame>
  );
}
