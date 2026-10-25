'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { paymentListAction } from '@/server/domains/vendors/payment-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { VOUCHER_KIND, VOUCHER_STATUS } from '@/lib/vendor-payment';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof paymentListAction>>, { ok: true }>['data'];

export function PaymentListClient({ initialPromise }: { initialPromise: ReturnType<typeof paymentListAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ListView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ListView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [status, setStatus] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const load = async (s: Choice | null, before: Page['next'], append: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(paymentListAction({ status: s?.id, before }));
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
      <PageHeader title="Payments to vendors" intro="Payment vouchers: prepared by one person, approved by another, and paid when the money has gone." actions={<><Link href="/admin/vendors/payables" className={buttonClass}>What we owe</Link><Link href="/admin/vendors/payments/runs" className={buttonClass}>Payment runs</Link><Link href="/admin/vendors/payments/new" className={primaryClass}>New payment</Link></>} />
      <Message notice={notice} />
      <div className={`${cardClass} max-w-xs`}><ChoicePicker label="Status" source="voucher-statuses" choice={status} onChoice={(c) => { setStatus(c); void load(c, null, false); }} placeholder="All" /></div>
      {rows.length === 0 ? <p className="text-sm text-fg-muted">{busy ? 'Loading…' : 'No payment vouchers here.'}</p> : (
        <ul className="space-y-2" aria-label="Payment vouchers">
          {rows.map((r) => {
            const s = VOUCHER_STATUS[r.status];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/payments/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number ?? 'Not numbered yet'} · {r.vendorName}</span><span className="block text-xs text-fg-muted">{VOUCHER_KIND[r.kind]} · {r.methodName} · {r.amount} {r.currency}</span></span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(status, next, true)}>Show older vouchers</button>}
    </div>
  );
}
