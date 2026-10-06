import { notFound } from 'next/navigation';
import { findNavItemById } from '@/config/admin-nav';
import { AdminNavHub } from '@/components/admin/nav/AdminNavHub';

export default function AdminKraTimsEtimsHubPage() {
  const section = findNavItemById('settings-kra-tims-etims');
  if (!section) notFound();
  return <AdminNavHub section={section} />;
}
