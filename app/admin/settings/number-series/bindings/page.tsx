import { getBindingsAction } from '@/server/kernel/numbering/actions';
import { DocumentNumberingClient } from '@/components/admin/settings/numbering/DocumentNumberingClient';

export default async function AdminDocumentNumberingPage() {
  const result = await getBindingsAction();
  if (!result.ok) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {result.error}
      </p>
    );
  }
  return <DocumentNumberingClient view={result.data} />;
}
