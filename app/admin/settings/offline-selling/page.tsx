import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { OfflineSellingClient } from '@/components/admin/settings/offline-selling/OfflineSellingClient';
import { offlineSellingScreenAction } from '@/server/domains/selling/offline/offline-actions';

export const metadata: Metadata = { title: 'Offline selling' };

export default function OfflineSellingPage() {
  const first = offlineSellingScreenAction();
  return (
    <SettingsFrame label="offline selling">
      <OfflineSellingClient firstPromise={first} />
    </SettingsFrame>
  );
}
