import type { Metadata } from 'next';
import { deliveryZonesPageAction } from '@/server/domains/delivery/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { DeliveryZonesClient } from '@/components/admin/delivery/DeliveryZonesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Delivery zones' };

export default function DeliveryZonesPage() {
  // Both start now and run side by side; the frame shows at once.
  const firstPage = deliveryZonesPageAction({});
  const canManage = canPermission('deliveries:manage');
  return (
    <SettingsFrame label="delivery zones">
      <DeliveryZonesClient firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
