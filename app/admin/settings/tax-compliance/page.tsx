import { notFound } from 'next/navigation';
import { findNavItemById } from '@/config/admin-nav';
import { AdminNavHub } from '@/components/admin/nav/AdminNavHub';

export default function AdminTaxComplianceHubPage() {
  const section = findNavItemById('settings-tax-compliance');
  if (!section) notFound();
  return <AdminNavHub section={section} />;
}
