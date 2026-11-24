import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { RepsClient } from '@/components/admin/van-sales/RepsClient';
import { repsPageAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'Sales reps' };

export default function RepsPage() {
  const first = repsPageAction({});
  return (
    <SettingsFrame label="the sales reps">
      <RepsClient firstPromise={first} />
    </SettingsFrame>
  );
}
