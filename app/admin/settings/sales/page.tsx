import { notFound } from 'next/navigation';
import { findNavItemById } from '@/config/admin-nav';
import { AdminNavHub } from '@/components/admin/nav/AdminNavHub';

export default function AdminSalesSettingsHubPage() {
  const section = findNavItemById('settings-sales');
  if (!section) notFound();
  return <AdminNavHub section={section} />;
}
