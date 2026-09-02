import { listProductsAction } from '@/server/domains/catalog/actions';
import { listInventoryLedgerAction } from '@/server/domains/inventory/actions';
import { AdminInventoryClient } from '@/components/admin/AdminInventoryClient';

export default async function Page() {
  const productsPromise = listProductsAction();
  const ledgerPromise = listInventoryLedgerAction();
  return (
    <AdminInventoryClient productsPromise={productsPromise} ledgerPromise={ledgerPromise} />
  );
}
