import { listProductsAction, listCategoriesAction } from '@/server/domains/catalog/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { AdminProductsClient } from '@/components/admin/AdminProductsClient';

export default async function AdminProductsPage() {
  const productsPromise = listProductsAction();
  const categoriesPromise = listCategoriesAction();
  const [canDelete, canPurge] = await Promise.all([
    canPermission('products:delete'),
    canPermission('products:delete_permanently'),
  ]);
  return (
    <AdminProductsClient
      productsPromise={productsPromise}
      categoriesPromise={categoriesPromise}
      canDelete={canDelete}
      canPurge={canPurge}
    />
  );
}
