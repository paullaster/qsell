import { notFound } from 'next/navigation';
import { getNumberSeriesAction } from '@/server/kernel/numbering/actions';
import { NumberSeriesDetailClient } from '@/components/admin/settings/numbering/NumberSeriesDetailClient';

export default async function AdminNumberSeriesDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getNumberSeriesAction(id);
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') notFound();
    return (
      <p role="alert" className="text-sm text-red-700">
        {result.error}
      </p>
    );
  }
  return <NumberSeriesDetailClient initial={result.data} />;
}
