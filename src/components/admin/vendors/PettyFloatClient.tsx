'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { approveTopUpAction, cancelTopUpAction, payTopUpAction, requestTopUpAction, type pettyFloatAction } from '@/server/domains/vendors/petty-cash-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { PETTY_STATUS, REPLENISHMENT_STATUS, fmt } from '@/lib/petty-cash';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof pettyFloatAction>>, { ok: true }>['data'];
type Result = { ok: true; data?: unknown } | { ok: false; error: string };

export function PettyFloatClient({ viewPromise }: { viewPromise: ReturnType<typeof pettyFloatAction> }) {
  const res = use(viewPromise);
  return res.ok ? <FloatView data={res.data} /> : <LoadFailed error={res.error} />;
}

function FloatView({ data }: { data: Data }) {
  const uid = useId();
  const router = useRouter();
  const f = data.float;
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [method, setMethod] = useState<Choice | null>(null);
  const [amount, setAmount] = useState('');
  const [countNote, setCountNote] = useState('');
  const [reference, setReference] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const act = async (call: Promise<Result>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return false;
    }
    setNotice({ kind: 'ok', text: done });
    router.refresh();
    return true;
  };
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={`${f.name} (${f.code})`}
        intro={<span className="flex flex-wrap items-center gap-2"><span>Looked after by {f.custodianName}</span>{f.low ? <Chip tone="red">Below its minimum</Chip> : null}{f.active ? null : <Chip tone="gray">Switched off</Chip>}</span>}
        actions={<><Link href="/admin/vendors/petty-cash" className={buttonClass}>All floats</Link>{data.can.create && f.active ? <Link href={`/admin/vendors/petty-cash/vouchers/new?float=${f.id}`} className={primaryClass}>New voucher</Link> : null}</>}
      />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-1`} aria-label="Cash in the float">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-fg-muted">Cash in the float</dt><dd className="text-lg font-bold tabular-nums text-fg-strong">{fmt(f.balanceCents)} {f.currency}</dd></div>
          <div><dt className="text-xs text-fg-muted">Topped up to</dt><dd className="font-medium tabular-nums text-fg-strong">{f.floatAmount}</dd></div>
          <div><dt className="text-xs text-fg-muted">Paid out today</dt><dd className="font-medium tabular-nums text-fg-strong">{fmt(f.spentTodayCents)} of {f.dailyLimit}</dd></div>
          <div><dt className="text-xs text-fg-muted">One voucher at most</dt><dd className="font-medium tabular-nums text-fg-strong">{f.perVoucherLimit}</dd></div>
        </dl>
      </section>

      <section className={`${cardClass} space-y-2`} aria-label="Vouchers">
        <h2 className="text-sm font-bold text-fg-strong">Vouchers</h2>
        {data.vouchers.length === 0 ? <p className="text-sm text-fg-muted">No vouchers yet.</p> : (
          <ul className="divide-y divide-line" aria-label="Petty cash vouchers">
            {data.vouchers.map((v) => {
              const s = PETTY_STATUS[v.status];
              return (
                <li key={v.id}>
                  <Link href={`/admin/vendors/petty-cash/vouchers/${v.id}`} className="flex min-h-10 flex-wrap items-center justify-between gap-2 py-2 hover:bg-hover">
                    <span className="min-w-0 text-sm text-fg"><span className="font-semibold">{v.number ?? 'Not numbered yet'}</span> · {v.payeeName}<span className="block text-xs text-fg-muted">{v.description}{v.covered ? ' · covered by a top-up' : ''}</span></span>
                    <span className="flex items-center gap-2"><span className="text-sm font-semibold tabular-nums">{v.amount}</span><Chip tone={s.tone}>{s.label}</Chip></span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={`${cardClass} space-y-3`} aria-label="Top-ups">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-fg-strong">Top-ups</h2>
          {data.can.create && f.active ? <button type="button" className={buttonClass} onClick={() => setAsking((x) => !x)}>Ask for a top-up</button> : null}
        </div>
        <p className="text-xs text-fg-muted">A top-up moves money from a bank account into the float, up to the amount it is topped up to. It lists the vouchers paid since the last one.</p>
        {asking ? (
          <form className="space-y-3 rounded-lg border border-line p-3" aria-label="Ask for a top-up" onSubmit={(e) => { e.preventDefault(); void act(requestTopUpAction({ floatId: f.id, fromMethodId: method?.id ?? '', amount, countNote }), 'The top-up is waiting for approval.').then((ok) => { if (ok) setAsking(false); }); }}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ChoicePicker label="Where the money comes from" source="petty-topup-methods" choice={method} onChoice={setMethod} placeholder="Choose a way of paying" />
              <Field id={`${uid}-a`} label="Amount" hint="Leave empty to bring the float back up to its amount."><input id={`${uid}-a`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            </div>
            <Field id={`${uid}-cn`} label="What the cash count showed (optional)"><input id={`${uid}-cn`} value={countNote} maxLength={400} onChange={(e) => setCountNote(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
            <button type="submit" className={primaryClass} disabled={busy || method === null}>Ask for the top-up</button>
          </form>
        ) : null}
        {data.replenishments.length === 0 ? <p className="text-sm text-fg-muted">No top-ups yet.</p> : (
          <ul className="space-y-3" aria-label="Top-up requests">
            {data.replenishments.map((r) => {
              const s = REPLENISHMENT_STATUS[r.status] ?? { label: r.status, tone: 'gray' as const };
              return (
                <li key={r.id} className="rounded-lg border border-line p-3 text-sm text-fg">
                  <p className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{r.number} · {r.amount}</span><Chip tone={s.tone}>{s.label}</Chip></p>
                  <p className="text-xs text-fg-muted">Asked by {r.createdName ?? 'someone'}{r.approvedName === null ? '' : `, approved by ${r.approvedName}`}{r.reference === null ? '' : `, reference ${r.reference}`}{r.countNote === null ? '' : ` · ${r.countNote}`}</p>
                  {r.status === 'pending_approval' && data.can.approve ? <button type="button" className={`${primaryClass} mt-2`} disabled={busy} onClick={() => void act(approveTopUpAction(r.id), 'Approved.')}>Approve</button> : null}
                  {r.status === 'approved' && data.can.pay ? (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <Field id={`${uid}-ref-${r.id}`} label="Reference of the transfer or withdrawal"><input id={`${uid}-ref-${r.id}`} value={reference[r.id] ?? ''} maxLength={120} onChange={(e) => setReference((p) => ({ ...p, [r.id]: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
                      <button type="button" className={primaryClass} disabled={busy || (reference[r.id] ?? '').trim() === ''} onClick={() => void act(payTopUpAction(r.id, reference[r.id] ?? ''), 'Paid. The cash is in the float.')}>Record it as paid</button>
                    </div>
                  ) : null}
                  {(r.status === 'pending_approval' || r.status === 'approved') && data.can.create ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input aria-label={`Why cancel ${r.number}?`} placeholder="Why cancel it?" value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} className={`${fieldClass} w-56`} autoComplete="off" />
                      <InlineConfirm label={`Cancel top-up ${r.number}`} action="Cancel" confirm="Yes, cancel it" busy={busy || reason.trim() === ''} onConfirm={() => void act(cancelTopUpAction(r.id, reason), 'The top-up is cancelled.')} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
