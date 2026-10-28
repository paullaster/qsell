import { orderTargetsAction } from '@/server/domains/orders/sla-actions';
import { OrderTargetsClient } from '@/components/admin/orders/OrderTargetsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminOrderTargetsPage() {
  return (
    <SettingsFrame label="the order targets">
      <OrderTargetsClient initialPromise={orderTargetsAction()} />
    </SettingsFrame>
  );
}
