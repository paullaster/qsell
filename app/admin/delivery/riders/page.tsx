import type { Metadata } from 'next';
import { RidersClient } from '@/components/admin/delivery/RidersClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { riderSettingsAction } from '@/server/domains/delivery/rider-actions';

export const metadata: Metadata = { title: 'Riders' };

export default function RidersPage() {
  const settings = riderSettingsAction();
  return (
    <SettingsFrame label="riders">
      <RidersClient settingsPromise={settings} />
    </SettingsFrame>
  );
}
