import { notFound } from 'next/navigation';
import { findNavItemById } from '@/config/admin-nav';
import { AdminNavHub } from '@/components/admin/nav/AdminNavHub';

export default function AdminProductsInventoryHubPage() {
  const section = findNavItemById('products-inventory');
  if (!section) notFound();
  return <AdminNavHub section={section} />;
}
