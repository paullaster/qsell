'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { runListAction } from '@/server/domains/vendors/payment-run-actions';
import { RUN_STATUS } from '@/lib/vendor-payment-run';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof runListAction>>, { ok: true }>['data'];

export function PaymentRunListClient({ initialPromise }: { initialPromise: ReturnType<typeof runListAction> }) {
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
    const res = await attempt(runListAction({ before: next }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => [...r, ...res.data.rows]);
    setNext(res.data.next);
  };
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Payment runs" intro="Pay many vendors together: suggest what is due, approve it as one, then release it as a bank file or a cheque run." actions={<><Link href="/admin/vendors/payments" className={buttonClass}>All payments</Link><Link href="/admin/vendors/payments/runs/new" className={primaryClass}>New run</Link></>} />
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">There are no payment runs yet.</p> : (
        <ul className="space-y-2" aria-label="Payment runs">
          {rows.map((r) => {
            const s = RUN_STATUS[r.status];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/payments/runs/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number}</span><span className="block text-xs text-fg-muted">{r.count} {r.count === 1 ? 'vendor' : 'vendors'} · {r.total} {r.currency} · pay on {r.executionDate}</span></span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void more()}>Show older runs</button>}
    </div>
  );
}
