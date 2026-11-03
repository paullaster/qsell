import type { Metadata } from 'next';
import { RunsClient } from '@/components/admin/delivery/RunsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Delivery runs' };

export default function RunsPage() {
  return (
    <SettingsFrame label="delivery runs">
      <RunsClient />
    </SettingsFrame>
  );
}
