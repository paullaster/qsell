import { listNumberSeriesAction } from '@/server/kernel/numbering/actions';
import { NumberSeriesListClient } from '@/components/admin/settings/numbering/NumberSeriesListClient';

export default async function AdminNumberSeriesPage() {
  const result = await listNumberSeriesAction();
  if (!result.ok) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {result.error}
      </p>
    );
  }
  return <NumberSeriesListClient series={result.data} />;
}
