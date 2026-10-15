'use client';

import Link from 'next/link';
import { use, useCallback, useState } from 'react';
import { getNumberSeriesAction, type SeriesDetailView } from '@/server/kernel/numbering/actions';
import { Chip, LoadFailed, Message, PageHeader, attempt, type Notice } from '@/components/ui/screen-kit';
import { boundWords } from '@/lib/number-series-forms';
import { ModeChip } from './NumberSeriesListClient';
import { SeriesHistory, SeriesRecent } from './SeriesHistory';
import { SeriesLinesCard } from './SeriesLinesCard';
import { SeriesSettingsCard } from './SeriesSettingsCard';
import { SeriesTryItCard } from './SeriesTryItCard';

export type Report = (res: { ok: boolean; error?: string }, success: string) => Promise<boolean>;

export function NumberSeriesDetailClient({ detailPromise }: { detailPromise: ReturnType<typeof getNumberSeriesAction> }) {
  const first = use(detailPromise);
  return first.ok ? <SeriesScreen initial={first.data} /> : <LoadFailed error={first.error} />;
}

function SeriesScreen({ initial }: { initial: SeriesDetailView }) {
  const [data, setData] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const seriesId = initial.series.id;

  const reload = useCallback(async () => {
    const res = await attempt(getNumberSeriesAction(seriesId));
    if (res.ok) setData(res.data);
  }, [seriesId]);

  const report: Report = useCallback(
    async (res, success) => {
      if (res.ok) {
        setNotice({ kind: 'ok', text: success });
        await reload();
        return true;
      }
      setNotice({ kind: 'error', text: res.error ?? 'Something went wrong.' });
      return false;
    },
    [reload],
  );

  const { series } = data;
  return (
    <div className="max-w-5xl space-y-6">
      <Link href="/admin/settings/number-series" className="inline-flex min-h-10 items-center text-xs font-semibold text-indigo-500 underline">
        ← All number series
      </Link>
      <PageHeader
        title={`${series.code} — ${series.description}`}
        intro={data.boundTo.length === 0 ? 'Not used by any document yet. Link it under Document numbering.' : `Numbers: ${boundWords(data.boundTo)}.`}
        actions={
          <>
            <ModeChip mode={series.mode} />
            {series.isActive ? null : <Chip tone="gray">Inactive</Chip>}
          </>
        }
      />
      <Message notice={notice} />
      <SeriesSettingsCard data={data} report={report} />
      <SeriesLinesCard data={data} report={report} setNotice={setNotice} />
      <SeriesTryItCard seriesCode={series.code} />
      <SeriesRecentAndHistory data={data} />
    </div>
  );
}

function SeriesRecentAndHistory({ data }: { data: SeriesDetailView }) {
  return (
    <>
      <SeriesRecent recent={data.recent} />
      <SeriesHistory history={data.history} />
    </>
  );
}
