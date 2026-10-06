import { redirect } from 'next/navigation';

/** Direct visits and refreshes land on the full Branches screen; clicks from the Branch Modes dialog are intercepted. */
export default function BranchesFromBranchModesPage() {
  redirect('/admin/settings/branches');
}
