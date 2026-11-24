import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { VanSalesHomeClient } from '@/components/admin/van-sales/VanSalesHomeClient';
import { vanSalesOverviewAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'Van sales' };

export default function VanSalesPage() {
  const first = vanSalesOverviewAction();
  return (
    <SettingsFrame label="van sales">
      <VanSalesHomeClient firstPromise={first} />
    </SettingsFrame>
  );
}
