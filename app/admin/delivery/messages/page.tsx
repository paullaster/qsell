import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { CustomerMessagesClient } from '@/components/admin/delivery/CustomerMessagesClient';
import { customerMessagesAction } from '@/server/domains/delivery/message-actions';

export const metadata: Metadata = { title: 'Customer messages' };

export default function CustomerMessagesPage() {
  const first = customerMessagesAction();
  return (
    <SettingsFrame label="the customer messages">
      <CustomerMessagesClient firstPromise={first} />
    </SettingsFrame>
  );
}
