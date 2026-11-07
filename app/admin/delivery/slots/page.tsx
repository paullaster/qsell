import type { Metadata } from 'next';
import { SlotsClient } from '@/components/admin/delivery/SlotsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { slotsScreenAction } from '@/server/domains/delivery/slot-actions';

export const metadata: Metadata = { title: 'Delivery slots' };

export default function DeliverySlotsPage() {
  const first = slotsScreenAction();
  return (
    <SettingsFrame label="the delivery slots">
      <SlotsClient firstPromise={first} />
    </SettingsFrame>
  );
}
