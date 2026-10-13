import { notFound } from 'next/navigation';
import { returnDetailAction } from '@/server/domains/returns/actions';
import { ReturnDetailClient } from '@/components/admin/finance/ReturnDetailClient';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await returnDetailAction(id);
  if (!res.ok) {
    if (res.code === 'NOT_FOUND') notFound();
    return <LoadFailed error={res.error} />;
  }
  return <ReturnDetailClient view={res.data} />;
}
