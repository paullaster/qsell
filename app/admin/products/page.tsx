import { listProductsAction, listCategoriesAction } from '@/server/domains/catalog/actions';
import { AdminProductsClient } from '@/components/admin/AdminProductsClient';

export default async function AdminProductsPage() {
  const productsPromise = listProductsAction();
  const categoriesPromise = listCategoriesAction();
  return (
    <AdminProductsClient
      productsPromise={productsPromise}
      categoriesPromise={categoriesPromise}
    />
  );
}
