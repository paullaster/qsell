import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { DaysClient } from '@/components/admin/van-sales/DaysClient';
import { daysPageAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'Van days' };

export default function DaysPage() {
  const first = daysPageAction({});
  return (
    <SettingsFrame label="the van days">
      <DaysClient firstPromise={first} />
    </SettingsFrame>
  );
}
