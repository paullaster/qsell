import { notFound } from 'next/navigation';
import { findNavItemById } from '@/config/admin-nav';
import { AdminNavHub } from '@/components/admin/nav/AdminNavHub';

export default function AdminApprovalsHubPage() {
  const section = findNavItemById('approvals');
  if (!section) notFound();
  return <AdminNavHub section={section} />;
}
