'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { refundableAction, requestRefundAction, type refundsAction } from '@/server/domains/vendors/refund-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { REFUND_STATUS } from '@/lib/vendor-refund';
import { fromCents } from '@/lib/vendor-payment';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof refundsAction>>, { ok: true }>['data'];
type Credits = Extract<Awaited<ReturnType<typeof refundableAction>>, { ok: true }>['data']['credits'];
const KIND_WORDS = { payment: 'Payment on account', advance: 'Advance', credit_memo: 'Credit memo' } as const;

export function RefundListClient({ initialPromise }: { initialPromise: ReturnType<typeof refundsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <List data={res.data} /> : <LoadFailed error={res.error} />;
}

function List({ data }: { data: Data }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Refunds from vendors" intro="Money a vendor pays back: an overpayment, a deposit or advance not used, or a credit memo settled in cash." actions={data.can.create ? <button type="button" className={primaryClass} onClick={() => setAsking((x) => !x)}>New refund</button> : undefined} />
      {asking ? <NewRefund onDone={(id) => router.push(`/admin/vendors/refunds/${id}`)} /> : null}
      {data.refunds.length === 0 ? <p className="text-sm text-fg-muted">No refunds yet.</p> : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Refunds">
          {data.refunds.map((r) => {
            const s = REFUND_STATUS[r.status];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/refunds/${r.id}`} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-hover">
                  <span className="min-w-0 text-sm text-fg"><span className="font-semibold">{r.number ?? 'Not booked yet'}</span> · {r.vendor}<span className="block text-xs text-fg-muted">Returns {KIND_WORDS[r.creditKind]} {r.creditNo}{r.reference === null ? '' : ` · reference ${r.reference}`}</span></span>
                  <span className="flex items-center gap-2"><span className="text-sm font-semibold tabular-nums">{r.amount} {r.currency}</span><Chip tone={s.tone}>{s.label}</Chip></span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NewRefund({ onDone }: { onDone: (id: string) => void }) {
  const uid = useId();
  const [vendor, setVendor] = useState<Choice | null>(null);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [creditId, setCreditId] = useState('');
  const [method, setMethod] = useState<Choice | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const chooseVendor = async (c: Choice | null) => {
    setVendor(c);
    setCredits(null);
    setCreditId('');
    if (c === null) return;
    const res = await attempt(refundableAction(c.id));
    if (res.ok) setCredits(res.data.credits);
    else setNotice({ kind: 'error', text: res.error });
  };
  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(requestRefundAction({ creditEntryId: creditId, methodId: method?.id ?? '', amount, note }));
    setBusy(false);
    if (!res.ok) setNotice({ kind: 'error', text: res.error });
    else onDone(res.data.id);
  };
  return (
    <form className={`${cardClass} space-y-3`} aria-label="New refund" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Message notice={notice} />
      <ChoicePicker label="Vendor" source="vendors" createHref="/admin/vendors/new" createLabel="Add a vendor" listHref="/admin/vendors/browse" listLabel="View all vendors" choice={vendor} onChoice={(c) => void chooseVendor(c)} placeholder="Search by name or number" />
      {credits !== null && credits.length === 0 ? <p className="text-sm text-fg-muted" role="status">This vendor has nothing that can be refunded.</p> : null}
      {credits !== null && credits.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-fg">What is being paid back</legend>
          {credits.map((c) => (
            <label key={c.entryId} className="flex min-h-10 items-center gap-2 text-sm text-fg">
              <input type="radio" name={`${uid}-credit`} value={c.entryId} checked={creditId === c.entryId} onChange={() => setCreditId(c.entryId)} className="h-5 w-5" />
              {KIND_WORDS[c.kind]} {c.documentNo} · {c.postingDate} · open {fromCents(c.availableCents)} {c.currency}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="Money came in by" source="vendor-refund-methods" choice={method} onChoice={setMethod} placeholder="Choose a way of paying" />
        <Field id={`${uid}-a`} label="Amount" hint="Leave empty for all that is open."><input id={`${uid}-a`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
      </div>
      <Field id={`${uid}-n`} label="Note (optional)"><input id={`${uid}-n`} value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
      <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy || creditId === '' || method === null}>Ask for the refund to be booked</button></div>
    </form>
  );
}
