import type { Metadata } from 'next';
import { LateDeliveriesClient } from '@/components/admin/delivery/LateDeliveriesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { lateDeliveriesAction } from '@/server/domains/delivery/slot-actions';

export const metadata: Metadata = { title: 'Late deliveries' };

export default function LateDeliveriesPage() {
  const first = lateDeliveriesAction();
  return (
    <SettingsFrame label="the late deliveries">
      <LateDeliveriesClient firstPromise={first} />
    </SettingsFrame>
  );
}
