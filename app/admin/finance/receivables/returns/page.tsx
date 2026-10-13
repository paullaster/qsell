import { listReturnsAction } from '@/server/domains/returns/actions';
import { ReturnsClient } from '@/components/admin/finance/ReturnsClient';
import { LoadFailed } from '@/components/admin/finance/ui';

/** Returns are about stock as much as money, so this page does not wait for the books to be set up. */
export default async function AdminReturnsPage() {
  const res = await listReturnsAction('open');
  if (!res.ok) return <LoadFailed error={res.error} />;
  return <ReturnsClient initial={res.data} />;
}
