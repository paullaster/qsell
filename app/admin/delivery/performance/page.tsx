import type { Metadata } from 'next';
import { DeliveryPerformanceClient } from '@/components/admin/delivery/DeliveryPerformanceClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { deliveryPerformanceAction } from '@/server/domains/delivery/slot-actions';

export const metadata: Metadata = { title: 'Delivery performance' };

export default function DeliveryPerformancePage() {
  const report = deliveryPerformanceAction();
  return (
    <SettingsFrame label="delivery performance">
      <DeliveryPerformanceClient reportPromise={report} />
    </SettingsFrame>
  );
}
