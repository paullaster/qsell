import { listMyRequestsAction } from '@/server/kernel/approvals/actions';
import { MyRequestsClient } from '@/components/admin/approvals/MyRequestsClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminMyApprovalRequestsPage() {
  const result = await listMyRequestsAction();
  if (!result.ok) return <ErrorNote message={result.error} />;
  return <MyRequestsClient requests={result.data} />;
}
