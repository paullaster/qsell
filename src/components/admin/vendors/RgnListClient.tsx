'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { rgnListAction } from '@/server/domains/vendors/rgn-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { RGN_STATUS } from '@/lib/rgn';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof rgnListAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function RgnListClient({ initialPromise }: { initialPromise: ReturnType<typeof rgnListAction> }) {
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
    const res = await attempt(rgnListAction({ status: s?.id, before }));
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
      <PageHeader title="Received goods" intro="What arrived against purchase orders. Start a note from the order, with the vendor’s delivery note in hand." actions={<Link href="/admin/vendors/receipts/not-invoiced" className="text-sm font-semibold text-indigo-600 hover:underline">Received, not yet invoiced</Link>} />
      <div className={`${cardClass} max-w-xs`}><ChoicePicker label="Status" source="rgn-statuses" choice={status} onChoice={(c) => { setStatus(c); void load(c, null, false); }} placeholder="All" /></div>
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">Nothing received yet.</p> : (
        <ul className="space-y-2" aria-label="Received goods notes">
          {rows.map((r) => {
            const s = RGN_STATUS[r.status] ?? { label: r.status, tone: 'gray' as const };
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/receipts/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number ?? 'Draft'} · {r.vendorName}</span><span className="block text-xs text-fg-muted">{r.poNumber ?? ''} · delivery note {r.deliveryNoteNo} · {r.receivedDate}</span></span>
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
