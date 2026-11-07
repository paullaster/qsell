import type { Metadata } from 'next';
import { DeliveryReportClient } from '@/components/admin/delivery/DeliveryReportClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { deliveryReportAction } from '@/server/domains/delivery/cost-actions';

export const metadata: Metadata = { title: 'Delivery report' };

export default function DeliveryReportPage() {
  const report = deliveryReportAction();
  return (
    <SettingsFrame label="the delivery report">
      <DeliveryReportClient reportPromise={report} />
    </SettingsFrame>
  );
}
