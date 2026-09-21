import { notFound } from 'next/navigation';
import { findNavItemById } from '@/config/admin-nav';
import { AdminNavHub } from '@/components/admin/nav/AdminNavHub';

export default function AdminTransactionsHubPage() {
  const section = findNavItemById('transactions');
  if (!section) notFound();
  return <AdminNavHub section={section} />;
}
