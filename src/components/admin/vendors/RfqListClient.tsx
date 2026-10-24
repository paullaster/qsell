'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { rfqListAction } from '@/server/domains/vendors/rfq-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { RFQ_STATUS } from '@/lib/rfq';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof rfqListAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function RfqListClient({ initialPromise }: { initialPromise: ReturnType<typeof rfqListAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ListView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ListView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [status, setStatus] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = async (s: Choice | null, before: Page['next'], append: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(rfqListAction({ status: s?.id, before }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => (append ? [...r, ...res.data.rows] : res.data.rows));
    setNext(res.data.next);
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Requests for quotation" intro="One request sent to several qualified vendors, answered in confidence, compared, then awarded." actions={initial.can.create ? <Link href="/admin/vendors/rfqs/new" className={primaryClass}>New request</Link> : null} />
      <div className={`${cardClass} max-w-xs`}>
        <ChoicePicker label="Status" source="rfq-statuses" choice={status} onChoice={(c) => { setStatus(c); void load(c, null, false); }} placeholder="All" />
      </div>
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">No requests yet.</p> : (
        <ul className="space-y-2" aria-label="Requests for quotation">
          {rows.map((r) => {
            const s = RFQ_STATUS[r.status] ?? { label: r.status, tone: 'gray' as const };
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/rfqs/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number ?? 'Draft'} · {r.title}</span><span className="block text-xs text-fg-muted">{r.categoryName} · {r.invited} invited · due {new Date(r.deadline).toLocaleString()}</span></span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next !== null ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(status, next, true)}>Show more</button> : null}
    </div>
  );
}
