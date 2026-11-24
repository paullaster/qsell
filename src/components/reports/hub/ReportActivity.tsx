'use client';

import { Suspense, use, useState } from 'react';
import { formatInstant } from '@/lib/reports/format';
import {
  listReportAuditAction,
  type AuditListItem,
  type AuditListResult,
} from '@/server/domains/reports/actions';
import { BackButton } from '../kit/BackButton';
import { DataTable, type TableRow } from '../kit/DataTable';
import { EmptyPanel, FailedPanel, Panel, PanelSkeleton } from '../kit/Panel';

const COLUMNS = [
  { label: 'When', kind: 'date' },
  { label: 'Who', kind: 'text' },
  { label: 'Report', kind: 'text' },
  { label: 'What', kind: 'text' },
  { label: 'Rows', kind: 'count' },
  { label: 'File fingerprint', kind: 'text' },
] as const;

const WHAT = { csv: 'Downloaded CSV', xlsx: 'Downloaded Excel', pdf: 'Downloaded PDF' } as const;

function describe(r: AuditListItem): string {
  if (r.action === 'run') return 'Opened';
  return r.format !== null && r.format in WHAT ? WHAT[r.format as keyof typeof WHAT] : 'Downloaded';
}

/** Who ran or downloaded sensitive reports, newest first. The page and its heading draw at once; the list streams in. */
export function ReportActivity({
  listPromise,
  timeZone,
}: {
  listPromise: Promise<AuditListResult>;
  timeZone: string;
}) {
  return (
    <div className="mx-auto max-w-7xl space-y-5 p-3 sm:p-5">
      <BackButton />
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-fg-strong sm:text-2xl">Report activity</h2>
        <p className="text-sm text-fg-muted">Who opened or downloaded a report, and when.</p>
      </header>
      <Suspense fallback={<PanelSkeleton label="report activity" rows={4} />}>
        <Loaded listPromise={listPromise} timeZone={timeZone} />
      </Suspense>
    </div>
  );
}

function Loaded({
  listPromise,
  timeZone,
}: {
  listPromise: Promise<AuditListResult>;
  timeZone: string;
}) {
  const first = use(listPromise);
  if (!first.ok) return <FailedPanel name="Report activity" />;
  return <List initial={first.data} timeZone={timeZone} />;
}

function List({
  initial,
  timeZone,
}: {
  initial: { rows: AuditListItem[]; next: number | null };
  timeZone: string;
}) {
  const [rows, setRows] = useState(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const more = async () => {
    if (next === null) return;
    setBusy(true);
    setProblem(null);
    const r = await listReportAuditAction({ before: next });
    setBusy(false);
    if (r.ok) {
      setRows((current) => [...current, ...r.data.rows]);
      setNext(r.data.next);
    } else setProblem(r.error);
  };

  const tableRows: TableRow[] = rows.map((r) => ({
    id: String(r.id),
    cells: [
      formatInstant(r.occurredAt, timeZone),
      r.userName ?? 'A person no longer in the system',
      r.reportTitle,
      describe(r),
      r.rowCount,
      r.contentHash === null ? '' : r.contentHash.slice(0, 12),
    ],
  }));

  return (
    <Panel id="activity" title="Latest first">
      {rows.length === 0 ? (
        <EmptyPanel>
          Nothing has been recorded yet. Downloads, and runs of sensitive reports, appear here.
        </EmptyPanel>
      ) : (
        <DataTable
          caption="Report activity"
          columns={COLUMNS}
          rows={tableRows}
          emptyMessage="Nothing recorded."
        />
      )}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {problem}
        </p>
      )}
      {next === null ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void more()}
          className="min-h-11 w-full rounded-xl border border-line text-sm font-semibold text-fg hover:bg-hover disabled:opacity-60"
        >
          {busy ? 'Loading…' : 'Show more'}
        </button>
      )}
    </Panel>
  );
}
