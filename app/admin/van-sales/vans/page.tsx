import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { VansClient } from '@/components/admin/van-sales/VansClient';
import { vansPageAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'Vans' };

export default function VansPage() {
  const first = vansPageAction({});
  return (
    <SettingsFrame label="the vans">
      <VansClient firstPromise={first} />
    </SettingsFrame>
  );
}
