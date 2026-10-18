import { inventoryPostingOverviewAction } from '@/server/domains/finance/inventory-posting-actions';
import { InventoryPostingClient } from '@/components/admin/finance/InventoryPostingClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = inventoryPostingOverviewAction();
  return (
    <FinancePage label="stock in the books">
      <InventoryPostingClient viewPromise={view} />
    </FinancePage>
  );
}
