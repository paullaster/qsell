import {
  listProductsAction,
  listCategoriesAction,
  trashCountAction,
} from '@/server/domains/catalog/actions';
import { AdminProductsClient } from '@/components/admin/AdminProductsClient';

export default async function AdminProductsPage() {
  const productsPromise = listProductsAction();
  const categoriesPromise = listCategoriesAction();
  const trashCount = await trashCountAction();
  return (
    <AdminProductsClient
      productsPromise={productsPromise}
      categoriesPromise={categoriesPromise}
      trashCount={trashCount}
    />
  );
}
