import type { Metadata } from 'next';
import { DeliveryDetailClient } from '@/components/admin/delivery/DeliveryDetailClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { MissingAs404 } from '@/components/ui/missing-record';
import { canPermission } from '@/server/domains/access-control/guard';
import { deliveryAction } from '@/server/domains/delivery/document-actions';
import { deliveryExtrasAction } from '@/server/domains/delivery/run-actions';

export const metadata: Metadata = { title: 'Delivery' };

export default function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => deliveryAction(id));
  const extras = params.then(({ id }) => deliveryExtrasAction(id));
  const canFulfil = canPermission('deliveries:fulfil');
  return (
    <SettingsFrame label="the delivery">
      <MissingAs404 result={view}>
        <DeliveryDetailClient viewPromise={view} canFulfil={canFulfil} extras={extras} />
      </MissingAs404>
    </SettingsFrame>
  );
}
