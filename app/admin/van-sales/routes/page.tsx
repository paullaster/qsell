import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { RoutesClient } from '@/components/admin/van-sales/RoutesClient';
import { routesPageAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'Routes' };

export default function RoutesPage() {
  const first = routesPageAction({});
  return (
    <SettingsFrame label="the routes">
      <RoutesClient firstPromise={first} />
    </SettingsFrame>
  );
}
