import { listInboxAction } from '@/server/kernel/approvals/actions';
import { ApprovalInboxClient } from '@/components/admin/approvals/ApprovalInboxClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminApprovalsInboxPage() {
  const result = await listInboxAction();
  if (!result.ok) return <ErrorNote message={result.error} />;
  return <ApprovalInboxClient items={result.data} />;
}
