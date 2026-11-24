import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { PartialBillingClient } from '@/components/admin/settings/partial-billing/PartialBillingClient';
import { partialBillingScreenAction } from '@/server/domains/selling/partial-billing-actions';

export const metadata: Metadata = { title: 'Partial billing' };

export default function PartialBillingPage() {
  const first = partialBillingScreenAction();
  return (
    <SettingsFrame label="partial billing">
      <PartialBillingClient firstPromise={first} />
    </SettingsFrame>
  );
}
