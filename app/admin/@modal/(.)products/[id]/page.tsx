import {
  getProductAction,
  listCategoriesAction,
  listItemTypesAction,
} from '@/server/domains/catalog/actions';
import { listTaxCategoriesAction } from '@/server/domains/taxes/actions';
import { AdminProductModalClient } from '@/components/admin/AdminProductModalClient';

export default async function InterceptedAdminProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ duplicateFrom?: string | string[] }>;
}) {
  const [{ id }, { duplicateFrom }] = await Promise.all([params, searchParams]);
  const duplicateFromId = id === 'new' && typeof duplicateFrom === 'string' ? duplicateFrom : null;
  const duplicateFromPromise = duplicateFromId
    ? getProductAction(duplicateFromId)
    : Promise.resolve(null);
  const productPromise = id === 'new' ? Promise.resolve(null) : getProductAction(id);
  const categoriesPromise = listCategoriesAction();
  const itemTypesPromise = listItemTypesAction();
  const taxesPromise = listTaxCategoriesAction();

  return (
    <AdminProductModalClient
      productPromise={productPromise}
      duplicateFromPromise={duplicateFromPromise}
      categoriesPromise={categoriesPromise}
      itemTypesPromise={itemTypesPromise}
      taxesPromise={taxesPromise}
    />
  );
}
