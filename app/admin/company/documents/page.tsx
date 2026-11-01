import { companyDocumentLayoutsAction } from '@/server/domains/company/actions';
import { CompanyDocumentLayoutsClient } from '@/components/admin/company/CompanyDocumentLayoutsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminCompanyDocumentsPage() {
  return (
    <SettingsFrame label="company document layouts">
      <CompanyDocumentLayoutsClient layoutsPromise={companyDocumentLayoutsAction()} />
    </SettingsFrame>
  );
}
