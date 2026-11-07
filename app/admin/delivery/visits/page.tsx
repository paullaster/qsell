import type { Metadata } from 'next';
import { VisitsClient } from '@/components/admin/delivery/VisitsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { visitsPageAction } from '@/server/domains/delivery/visit-actions';

export const metadata: Metadata = { title: 'Visits' };

export default function VisitsPage() {
  const first = visitsPageAction();
  return (
    <SettingsFrame label="the visits">
      <VisitsClient firstPromise={first} />
    </SettingsFrame>
  );
}
