import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { RegistersClient } from '@/components/admin/settings/registers/RegistersClient';
import { registersScreenAction } from '@/server/domains/selling/shifts/shift-actions';

export const metadata: Metadata = { title: 'Registers' };

export default function RegistersPage() {
  const first = registersScreenAction();
  return (
    <SettingsFrame label="registers">
      <RegistersClient firstPromise={first} />
    </SettingsFrame>
  );
}
