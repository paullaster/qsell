'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { vendorRfqsAction } from '@/server/domains/vendors/rfq-portal-actions';
import { VENDOR_STAGE } from '@/lib/rfq';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof vendorRfqsAction>>, { ok: true }>['data'];

export function RfqsListClient({ initialPromise }: { initialPromise: ReturnType<typeof vendorRfqsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ListView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ListView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const more = async () => {
    if (next === null) return;
    setBusy(true);
    const res = await attempt(vendorRfqsAction(next));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => [...r, ...res.data.rows]);
    setNext(res.data.next);
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Requests for quotation" intro="Every request you were invited to, in every stage." actions={<Link href="/vendor" className={buttonClass}>Back</Link>} />
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">You have not been invited to any request yet. Being qualified for a category in Prequalification makes you eligible.</p> : (
        <ul className="space-y-2" aria-label="Requests">
          {rows.map((r) => {
            const s = VENDOR_STAGE[r.stage];
            return (
              <li key={r.id}>
                <Link href={`/vendor/rfqs/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number ?? ''} · {r.title}</span><span className="block text-xs text-fg-muted">{r.category} · due {new Date(r.deadline).toLocaleString()}</span></span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void more()}>Show older requests</button>}
    </div>
  );
}
