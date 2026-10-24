'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { prequalQueueAction } from '@/server/domains/vendors/prequal-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { STATUS_WORDS } from '@/lib/prequalification';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof prequalQueueAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function PrequalQueueClient({ initialPromise }: { initialPromise: ReturnType<typeof prequalQueueAction> }) {
  const res = use(initialPromise);
  return res.ok ? <QueueView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function QueueView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [status, setStatus] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = async (s: Choice | null, before: Page['next'], append: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(prequalQueueAction({ status: s?.id, before }));
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
      <PageHeader title="Prequalification applications" intro="Applications waiting to be evaluated by default. Filter to see qualified, refused or suspended vendors." actions={<Link href="/admin/vendors/categories" className="text-sm font-semibold text-indigo-600 hover:underline">Categories</Link>} />
      <div className={`${cardClass} max-w-xs`}>
        <ChoicePicker label="Show" source="prequal-statuses" choice={status} onChoice={(c) => { setStatus(c); void load(c, null, false); }} placeholder="Waiting for evaluation" />
      </div>
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">Nothing here.</p> : (
        <ul className="space-y-2" aria-label="Applications">
          {rows.map((r) => {
            const s = STATUS_WORDS[r.status] ?? { label: r.status, tone: 'gray' as const };
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/prequalification/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.vendorName}</span><span className="block text-xs text-fg-muted">{r.categoryName}{r.submittedAt === null ? '' : ` · sent ${new Date(r.submittedAt).toLocaleDateString()}`}{r.validUntil === null ? '' : ` · until ${r.validUntil}`}</span></span>
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
