import type { Metadata } from 'next';
import { OfflineTillClient } from '@/components/admin/cash-sales/OfflineTillClient';
import { requirePermission } from '@/server/domains/access-control/guard';

export const metadata: Metadata = { title: 'Offline till' };

export default async function OfflineTillPage() {
  // Who may sell is decided here, once, while online; the till itself then runs from what the browser kept.
  await requirePermission('cash_sales:create');
  return <OfflineTillClient />;
}
