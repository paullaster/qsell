'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { vendorCreditsAction } from '@/server/domains/vendors/credit-memo-portal-actions';
import { CREDIT_STATE } from '@/lib/vendor-credit-memo';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof vendorCreditsAction>>, { ok: true }>['data'];

export function CreditsListClient({ initialPromise }: { initialPromise: ReturnType<typeof vendorCreditsAction> }) {
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
    const res = await attempt(vendorCreditsAction(next));
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
      <PageHeader title="Credit notes" intro="If you billed too much on an invoice, send a credit note for it. We check it and take it off what we owe you." actions={<><Link href="/vendor" className={buttonClass}>Back</Link><Link href="/vendor/credits/new" className={primaryClass}>New credit note</Link></>} />
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">You have not made a credit note yet.</p> : (
        <ul className="space-y-2" aria-label="Credit notes">
          {rows.map((r) => {
            const s = CREDIT_STATE[r.state];
            return (
              <li key={r.id}>
                <Link href={`/vendor/credits/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.vendorCreditNo}</span><span className="block text-xs text-fg-muted">{r.number === null ? 'Not sent yet' : `Our number ${r.number}`} · for invoice {r.invoiceNo} · {r.total} {r.currency}</span></span>
                  <span className="flex items-center gap-2">{r.needsAction ? <Chip tone="amber">Please correct</Chip> : null}<Chip tone={s.tone}>{s.label}</Chip></span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void more()}>Show older credit notes</button>}
    </div>
  );
}
