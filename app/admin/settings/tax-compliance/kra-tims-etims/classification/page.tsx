import { taxCategoriesPageAction, taxSummaryAction } from '@/server/domains/taxes/actions';
import { AdminTaxesClient } from '@/components/admin/AdminTaxesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminKraTaxClassificationPage() {
  return (
    <SettingsFrame label="tax classification">
      <AdminTaxesClient firstPage={taxCategoriesPageAction({})} summary={taxSummaryAction()} />
    </SettingsFrame>
  );
}
