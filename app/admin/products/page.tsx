import {
  listProductsAction,
  listCategoriesAction,
  trashCountAction,
} from '@/server/domains/catalog/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { AdminProductsClient } from '@/components/admin/AdminProductsClient';

export default async function AdminProductsPage() {
  const productsPromise = listProductsAction();
  const categoriesPromise = listCategoriesAction();
  const [canDelete, canPurge, trashCount] = await Promise.all([
    canPermission('products:delete'),
    canPermission('products:delete_permanently'),
    trashCountAction(),
  ]);
  return (
    <AdminProductsClient
      productsPromise={productsPromise}
      categoriesPromise={categoriesPromise}
      canDelete={canDelete}
      canPurge={canPurge}
      trashCount={trashCount}
    />
  );
}
