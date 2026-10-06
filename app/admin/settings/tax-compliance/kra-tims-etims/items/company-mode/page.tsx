import { redirect } from 'next/navigation';

/** Direct visits and refreshes land on the full screen; clicks from the items page are intercepted into a dialog. */
export default function CompanyModeFromItemsPage() {
  redirect('/admin/settings/tax-compliance/kra-tims-etims/company');
}
