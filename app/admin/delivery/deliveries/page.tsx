import type { Metadata } from 'next';
import { DeliveriesClient } from '@/components/admin/delivery/DeliveriesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Deliveries' };

export default function DeliveriesPage() {
  return (
    <SettingsFrame label="deliveries">
      <DeliveriesClient />
    </SettingsFrame>
  );
}
