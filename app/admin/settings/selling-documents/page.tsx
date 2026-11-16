import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { SellingSettingsClient } from '@/components/admin/settings/selling/SellingSettingsClient';
import { sellingSettingsScreenAction } from '@/server/domains/selling/actions';

export const metadata: Metadata = { title: 'Selling documents' };

export default function SellingDocumentsPage() {
  const first = sellingSettingsScreenAction();
  return (
    <SettingsFrame label="selling documents">
      <SellingSettingsClient firstPromise={first} />
    </SettingsFrame>
  );
}
