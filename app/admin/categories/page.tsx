import { listCategoriesAction, listProductsAction } from '@/server/domains/catalog/actions';
import { AdminCategoriesClient } from '@/components/admin/AdminCategoriesClient';

export default async function Page() {
  const categoriesPromise = listCategoriesAction();
  const productsPromise = listProductsAction();
  return (
    <AdminCategoriesClient
      categoriesPromise={categoriesPromise}
      productsPromise={productsPromise}
    />
  );
}
