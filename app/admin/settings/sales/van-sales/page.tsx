import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { VanSalesSettingsClient } from '@/components/admin/settings/van-sales/VanSalesSettingsClient';
import { vanSalesSettingsScreenAction } from '@/server/domains/van-sales/settings-actions';

export const metadata: Metadata = { title: 'Van sales' };

export default function VanSalesSettingsPage() {
  const first = vanSalesSettingsScreenAction();
  return (
    <SettingsFrame label="van sales">
      <VanSalesSettingsClient firstPromise={first} />
    </SettingsFrame>
  );
}
