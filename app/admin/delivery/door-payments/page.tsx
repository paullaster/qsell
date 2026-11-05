import type { Metadata } from 'next';
import { DoorPaymentsClient } from '@/components/admin/delivery/DoorPaymentsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { doorSettingsAction } from '@/server/domains/delivery/door-payment-actions';

export const metadata: Metadata = { title: 'Door payments' };

export default function DoorPaymentsPage() {
  const settings = doorSettingsAction();
  return (
    <SettingsFrame label="door payments">
      <DoorPaymentsClient settingsPromise={settings} />
    </SettingsFrame>
  );
}
