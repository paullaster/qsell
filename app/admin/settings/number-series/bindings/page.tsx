import { getBindingsAction } from '@/server/kernel/numbering/actions';
import { DocumentNumberingClient } from '@/components/admin/settings/numbering/DocumentNumberingClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminDocumentNumberingPage() {
  const view = getBindingsAction();
  return (
    <SettingsFrame label="document numbering">
      <DocumentNumberingClient viewPromise={view} />
    </SettingsFrame>
  );
}
