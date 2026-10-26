import { companyPoliciesAction } from '@/server/domains/company/actions';
import { AdminCompanyPoliciesClient } from '@/components/admin/AdminCompanyPoliciesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminCompanyPoliciesPage() {
  return (
    <SettingsFrame label="the policy pages">
      <AdminCompanyPoliciesClient policiesPromise={companyPoliciesAction()} />
    </SettingsFrame>
  );
}
