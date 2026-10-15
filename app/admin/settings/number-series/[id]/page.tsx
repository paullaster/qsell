import { getNumberSeriesAction } from '@/server/kernel/numbering/actions';
import { NumberSeriesDetailClient } from '@/components/admin/settings/numbering/NumberSeriesDetailClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function AdminNumberSeriesDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const detail = params.then(({ id }) => getNumberSeriesAction(id));
  return (
    <SettingsFrame label="number series">
      <MissingAs404 result={detail}>
        <NumberSeriesDetailClient detailPromise={detail} />
      </MissingAs404>
    </SettingsFrame>
  );
}
