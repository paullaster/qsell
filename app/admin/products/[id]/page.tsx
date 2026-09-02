import {
  getProductAction,
  listCategoriesAction,
} from '@/server/domains/catalog/actions';
import { listTaxCategoriesAction } from '@/server/domains/taxes/actions';
import { AdminProductModalClient } from '@/components/admin/AdminProductModalClient';

export default async function AdminProductEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const productPromise =
    id === 'new' ? Promise.resolve(null) : getProductAction(id);
  const categoriesPromise = listCategoriesAction();
  const taxesPromise = listTaxCategoriesAction();

  return (
    <AdminProductModalClient
      productPromise={productPromise}
      categoriesPromise={categoriesPromise}
      taxesPromise={taxesPromise}
    />
  );
}
