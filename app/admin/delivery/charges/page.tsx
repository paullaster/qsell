import type { Metadata } from 'next';
import { chargePoliciesPageAction } from '@/server/domains/delivery/policy-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { DeliveryChargesClient } from '@/components/admin/delivery/DeliveryChargesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Delivery charges' };

export default function DeliveryChargesPage() {
  // All three start now and run side by side; the frame shows at once.
  const firstPage = chargePoliciesPageAction({});
  const canManage = canPermission('delivery_rates:manage');
  return (
    <SettingsFrame label="delivery charges">
      <DeliveryChargesClient firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
