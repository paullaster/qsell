import { smsScreenAction } from '@/server/domains/sms/actions';
import { SmsProvidersClient } from '@/components/admin/settings/SmsProvidersClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminSmsProvidersPage() {
  return (
    <SettingsFrame label="the SMS providers">
      <SmsProvidersClient initialPromise={smsScreenAction()} />
    </SettingsFrame>
  );
}
