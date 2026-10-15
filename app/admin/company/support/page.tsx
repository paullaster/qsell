import { companySupportAction } from '@/server/domains/company/actions';
import { AdminCompanySupportClient } from '@/components/admin/AdminCompanySupportClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminCompanySupportPage() {
  return (
    <SettingsFrame label="the support settings">
      <AdminCompanySupportClient supportPromise={companySupportAction()} />
    </SettingsFrame>
  );
}
