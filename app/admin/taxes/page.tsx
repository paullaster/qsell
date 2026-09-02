import { listTaxCategoriesAction } from '@/server/domains/taxes/actions';
import { AdminTaxesClient } from '@/components/admin/AdminTaxesClient';

export default async function Page() {
  const taxesPromise = listTaxCategoriesAction();
  return <AdminTaxesClient taxesPromise={taxesPromise} />;
}
