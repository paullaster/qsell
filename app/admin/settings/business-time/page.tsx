import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { BusinessTimeClient } from '@/components/admin/settings/business-time/BusinessTimeClient';
import { businessTimeScreenAction } from '@/server/domains/company/business-time-actions';

export const metadata: Metadata = { title: 'Business time zone' };

export default function BusinessTimePage() {
  const first = businessTimeScreenAction();
  return (
    <SettingsFrame label="business time zone">
      <BusinessTimeClient firstPromise={first} />
    </SettingsFrame>
  );
}
