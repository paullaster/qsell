import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { CouriersClient } from '@/components/admin/delivery/CouriersClient';
import { couriersScreenAction } from '@/server/domains/delivery/courier-actions';

export const metadata: Metadata = { title: 'Couriers' };

export default function CouriersPage() {
  const first = couriersScreenAction();
  return (
    <SettingsFrame label="the couriers">
      <CouriersClient firstPromise={first} />
    </SettingsFrame>
  );
}
