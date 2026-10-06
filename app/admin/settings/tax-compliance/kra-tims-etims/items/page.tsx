import { listEtimsTargetsAction } from '@/server/domains/kra/etims/actions';
import { EtimsItemsClient } from '@/components/admin/settings/EtimsItemsClient';

export default async function AdminEtimsItemsPage() {
  const result = await listEtimsTargetsAction();
  return <EtimsItemsClient targets={result.ok ? result.data : []} />;
}
