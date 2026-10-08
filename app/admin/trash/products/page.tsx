import { canPermission } from '@/server/domains/access-control/guard';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';
import { ProductTrashClient } from '@/components/admin/ProductTrashClient';

export default async function AdminProductTrashPage() {
  const [canDelete, canPurge] = await Promise.all([
    canPermission('products:delete'),
    canPermission('products:delete_permanently'),
  ]);
  if (!canDelete)
    return <ErrorNote message="You do not have permission to see deleted products." />;
  return <ProductTrashClient canPurge={canPurge} />;
}
