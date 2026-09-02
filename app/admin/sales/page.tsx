import { notFound } from 'next/navigation';
import { findNavItemById } from '@/config/admin-nav';
import { AdminNavHub } from '@/components/admin/nav/AdminNavHub';

export default function AdminSalesHubPage() {
  const section = findNavItemById('sales');
  if (!section) notFound();
  return <AdminNavHub section={section} />;
}
