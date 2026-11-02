import type { Metadata } from 'next';
import { deliveryBillingPageAction } from '@/server/domains/delivery/billing-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { DeliveryInvoicingClient } from '@/components/admin/delivery/DeliveryInvoicingClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Delivery invoicing' };

export default function DeliveryInvoicingPage() {
  const data = deliveryBillingPageAction();
  const canManage = canPermission('deliveries:manage');
  return (
    <SettingsFrame label="delivery invoicing">
      <DeliveryInvoicingClient data={data} canManage={canManage} />
    </SettingsFrame>
  );
}
