import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { VehiclesClient } from '@/components/admin/delivery/VehiclesClient';
import { vehiclesScreenAction } from '@/server/domains/delivery/vehicle-actions';

export const metadata: Metadata = { title: 'Vehicles' };

export default function VehiclesPage() {
  const first = vehiclesScreenAction();
  return (
    <SettingsFrame label="the vehicles">
      <VehiclesClient firstPromise={first} />
    </SettingsFrame>
  );
}
