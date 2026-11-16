import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { EmailRoutingClient } from '@/components/admin/settings/email-routing/EmailRoutingClient';
import { emailRoutingScreenAction } from '@/server/domains/email-routing/actions';

export const metadata: Metadata = { title: 'Email routing' };

export default function EmailRoutingPage() {
  const first = emailRoutingScreenAction();
  return (
    <SettingsFrame label="email routing">
      <EmailRoutingClient firstPromise={first} />
    </SettingsFrame>
  );
}
