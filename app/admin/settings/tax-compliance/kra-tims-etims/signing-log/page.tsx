import { signingDocumentsPageAction } from '@/server/domains/kra/signing/actions';
import { SigningLogClient } from '@/components/admin/settings/SigningLogClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminKraSigningLogPage() {
  return (
    <SettingsFrame label="the signing log">
      <SigningLogClient firstPage={signingDocumentsPageAction({})} />
    </SettingsFrame>
  );
}
