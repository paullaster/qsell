import { dimensionValuesPageAction, getDimensionAction } from '@/server/domains/dimensions/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { AdminDimensionValuesClient } from '@/components/admin/settings/AdminDimensionValuesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminDimensionValuesPage({ params }: { params: Promise<{ id: string }> }) {
  // Nothing is awaited here: the dimension, its first page of values and the permission start at once.
  const dimension = params.then(({ id }) => getDimensionAction(id));
  const firstPage = params.then(({ id }) => dimensionValuesPageAction(id, {}));
  const canManage = canPermission('dimensions:manage');
  return (
    <SettingsFrame label="dimension values">
      <AdminDimensionValuesClient dimensionPromise={dimension} firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
