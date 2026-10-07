import { getLookupsAction, listProfilesAction } from '@/server/kernel/approvals/actions';
import { ApproversClient } from '@/components/admin/approvals/ApproversClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminApproversPage() {
  const [profiles, lookups] = await Promise.all([listProfilesAction(), getLookupsAction()]);
  if (!profiles.ok) return <ErrorNote message={profiles.error} />;
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <ApproversClient lookups={lookups.data} profiles={profiles.data} />;
}
