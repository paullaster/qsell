'use client';

import Link from 'next/link';
import { useState } from 'react';
import { listReturnsAction } from '@/server/domains/returns/actions';
import { Chip, Message, PageHeader, buttonClass, cardClass, type Notice, attempt } from './ui';

type Page = Extract<Awaited<ReturnType<typeof listReturnsAction>>, { ok: true }>['data'];

export const RETURN_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  awaiting_goods: { label: 'Waiting for the goods', tone: 'amber' },
  partially_confirmed: { label: 'Partly received', tone: 'sky' },
  confirmed: { label: 'Received', tone: 'green' },
  rejected: { label: 'Closed: not coming', tone: 'gray' },
};

export function ReturnsClient({ initial }: { initial: Page }) {
  const [rows, setRows] = useState(initial.rows);
  const [which, setWhich] = useState<'open' | 'closed'>('open');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const show = async (w: 'open' | 'closed') => {
    setBusy(true);
    const res = await attempt(listReturnsAction(w));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice(null);
    setWhich(w);
    setRows(res.data.rows);
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Returns"
        intro="Goods expected back because of a credit note. Stock goes up only when someone confirms what actually arrived, how many, and in what condition. Until then it is just a request."
        actions={
          <div role="group" aria-label="Show" className="flex gap-2">
            <button type="button" className={buttonClass} aria-pressed={which === 'open'} disabled={busy} onClick={() => void show('open')}>Waiting</button>
            <button type="button" className={buttonClass} aria-pressed={which === 'closed'} disabled={busy} onClick={() => void show('closed')}>Finished</button>
          </div>
        }
      />
      <Message notice={notice} />
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{which === 'open' ? 'No goods are waiting to be confirmed.' : 'Nothing has been finished yet.'}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/finance/receivables/returns/${r.id}`} className={`${cardClass} block min-h-10 hover:bg-hover`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-bold text-fg-strong">{r.number} <span className="font-normal text-fg-muted">· credit note {r.creditNoteNo} · order {r.order}</span></p>
                  <Chip tone={RETURN_STATUS[r.status]?.tone ?? 'gray'}>{RETURN_STATUS[r.status]?.label ?? r.status}</Chip>
                </div>
                <p className="mt-1 text-xs text-fg-muted">{r.received} of {r.expected} units received · asked {new Date(r.requestedAt).toLocaleDateString()}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
