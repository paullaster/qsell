import { listBranchesAction } from '@/server/domains/payments/actions';
import { AdminBranchesClient } from '@/components/admin/settings/AdminBranchesClient';

export default function AdminBranchesPage() {
  const branchesPromise = listBranchesAction();
  return <AdminBranchesClient branchesPromise={branchesPromise} />;
}
