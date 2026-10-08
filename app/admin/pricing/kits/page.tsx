import { listKitsAction } from '@/server/domains/pricing/kit-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { KitsClient } from '@/components/admin/pricing/KitsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminKitsPage() {
  const [kits, canManage] = await Promise.all([listKitsAction(), canPermission('pricing:manage')]);
  if (!kits.ok) return <ErrorNote message={kits.error} />;
  return <KitsClient kits={kits.data} canManage={canManage} />;
}
