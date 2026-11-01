import type { Metadata } from 'next';
import { deliveryMethodsPageAction } from '@/server/domains/delivery/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { DeliveryMethodsClient } from '@/components/admin/delivery/DeliveryMethodsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Delivery methods' };

export default function DeliveryMethodsPage() {
  const firstPage = deliveryMethodsPageAction({});
  const canManage = canPermission('deliveries:manage');
  return (
    <SettingsFrame label="delivery methods">
      <DeliveryMethodsClient firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
