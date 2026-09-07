import { listItemTypesAction, listProductsAction } from '@/server/domains/catalog/actions';
import { AdminItemTypesClient } from '@/components/admin/AdminItemTypesClient';

export default async function AdminItemTypesPage() {
  const itemTypesPromise = listItemTypesAction();
  const productsPromise = listProductsAction();
  return (
    <AdminItemTypesClient
      itemTypesPromise={itemTypesPromise}
      productsPromise={productsPromise}
    />
  );
}
