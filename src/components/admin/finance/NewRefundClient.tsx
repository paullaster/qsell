'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createRefundAction, refundOptionsAction, searchCustomersForRefundAction } from '@/server/domains/finance/refund-actions';
import { Field, Message, PageHeader, cardClass, buttonClass, fieldClass, primaryClass, money, type Notice, attempt } from './ui';

type Options = Extract<Awaited<ReturnType<typeof refundOptionsAction>>, { ok: true }>['data'];
type Found = { id: string; name: string; number: string; phone: string | null };

const SOURCE_WORDS: Record<string, string> = { credit_note_excess: 'Credit note excess', wallet: 'Wallet balance', receipt_unapplied: 'Overpaid receipt' };
const DETAIL_FIELDS: Record<string, { key: string; label: string; type?: string }[]> = {
  mobile_money: [{ key: 'phone', label: 'Phone number to pay', type: 'tel' }],
  bank_transfer: [{ key: 'bankName', label: 'Bank' }, { key: 'accountNumber', label: 'Account number' }, { key: 'accountName', label: 'Account name' }],
  bank_deposit: [{ key: 'bankName', label: 'Bank' }, { key: 'accountNumber', label: 'Account number' }, { key: 'accountName', label: 'Account name' }],
  gateway: [{ key: 'bankName', label: 'Bank' }, { key: 'accountNumber', label: 'Account number' }, { key: 'accountName', label: 'Account name' }],
  cheque: [{ key: 'payeeName', label: 'Cheque made out to' }],
  cash: [{ key: 'recipientName', label: 'Who will collect the cash' }],
};

export function NewRefundClient({ customerId, sourceKey }: { customerId?: string; sourceKey?: string }) {
  const uid = useId();
  const router = useRouter();
  const [customer, setCustomer] = useState<Found | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [opts, setOpts] = useState<Options | null>(null);
  const [source, setSource] = useState(sourceKey ?? '');
  const [amount, setAmount] = useState('');
  const [methodId, setMethodId] = useState('');
  const [details, setDetails] = useState<Record<string, string>>({});
  const [reason, setReason] = useState({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const loadFor = async (id: string) => {
    const res = await attempt(refundOptionsAction(id));
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setOpts(res.data);
  };
  useEffect(() => {
    if (!customerId) return;
    void loadFor(customerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);
  useEffect(() => {
    if (!opts || !source) return;
    const ob = opts.obligations.find((o) => `${o.kind}:${o.id}` === source);
    if (ob && !amount) setAmount(ob.available);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts, source]);

  const search = async () => {
    const res = await attempt(searchCustomersForRefundAction(q));
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice(null);
    setFound(res.data as Found[]);
  };
  const pick = async (c: Found) => {
    setCustomer(c);
    setFound([]);
    setSource('');
    setAmount('');
    setDetails(c.phone ? { phone: c.phone } : {});
    await loadFor(c.id);
  };

  const cid = customer?.id ?? customerId;
  const ob = opts?.obligations.find((o) => `${o.kind}:${o.id}` === source);
  const method = opts?.methods.find((m) => m.id === methodId);
  const chosenReason = opts?.reasons.find((r) => r.code === reason.code);

  const save = async (submit: boolean) => {
    if (!cid || !ob || !method) return;
    setBusy(true);
    setNotice(null);
    const res = await attempt(createRefundAction({ customerId: cid, sourceKind: ob.kind as never, sourceId: ob.id, amount, paymentMethodId: method.id, payoutDetails: details, reasonCode: reason.code, reasonText: reason.text.trim() || undefined, idempotencyKey: `${uid}-${cid}-${ob.id}-${amount}-${method.id}` }, submit));
    if (!res.ok) { setBusy(false); return setNotice({ kind: 'error', text: res.error }); }
    router.push(`/admin/finance/refunds/${res.data.id}${res.data.submitError ? `?note=${encodeURIComponent(res.data.submitError)}` : ''}`);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="New refund" intro="Pay a customer back from something they are owed. The amount can never be more than what is left." />
      <Message notice={notice} />
      {!cid ? (
        <section className={`${cardClass} space-y-3`}>
          <form onSubmit={(e) => { e.preventDefault(); void search(); }} className="flex flex-wrap items-end gap-2" role="search">
            <div className="min-w-48 flex-1"><Field id={`${uid}-q`} label="Find the customer"><input id={`${uid}-q`} value={q} onChange={(e) => setQ(e.target.value)} className={fieldClass} placeholder="Name, number or phone" autoComplete="off" /></Field></div>
            <button type="submit" className={buttonClass}>Search</button>
          </form>
          <ul className="space-y-1">{found.map((c) => <li key={c.id}><button type="button" className={`${buttonClass} w-full justify-start text-left`} onClick={() => void pick(c)}>{c.name} · {c.number}{c.phone ? ` · ${c.phone}` : ''}</button></li>)}</ul>
        </section>
      ) : (
        <form className={`${cardClass} space-y-4`} onSubmit={(e) => { e.preventDefault(); void save(true); }}>
          <p className="text-sm">Customer: <b>{customer?.name ?? opts?.customerName ?? '…'}</b></p>
          {opts && opts.obligations.length === 0 ? <p className="text-sm text-fg-muted" role="status">This customer is owed nothing that can be refunded.</p> : null}
          {opts && opts.obligations.length > 0 ? (
            <>
              <Field id={`${uid}-src`} label="Refund from">
                <select id={`${uid}-src`} value={source} onChange={(e) => { setSource(e.target.value); setAmount(''); }} className={fieldClass} required>
                  <option value="">Choose…</option>
                  {opts.obligations.map((o) => <option key={`${o.kind}:${o.id}`} value={`${o.kind}:${o.id}`}>{SOURCE_WORDS[o.kind]} — {o.label} ({o.currency} {money(o.available)} left)</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id={`${uid}-amt`} label={`Amount${ob ? ` (${ob.currency})` : ''}`} hint={ob ? `At most ${money(ob.available)}` : undefined}>
                  <input id={`${uid}-amt`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} required />
                </Field>
                <Field id={`${uid}-m`} label="Pay by">
                  <select id={`${uid}-m`} value={methodId} onChange={(e) => { setMethodId(e.target.value); setDetails(customer?.phone ? { phone: customer.phone } : {}); }} className={fieldClass} required>
                    <option value="">Choose…</option>
                    {opts.methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </Field>
              </div>
              {method ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {(DETAIL_FIELDS[method.kind] ?? []).map((f) => (
                    <Field key={f.key} id={`${uid}-d-${f.key}`} label={f.label} hint={f.key === 'phone' && !opts.canChangeDestination ? 'Only the number on the customer’s record can be used.' : undefined}>
                      <input id={`${uid}-d-${f.key}`} type={f.type ?? 'text'} value={details[f.key] ?? ''} onChange={(e) => setDetails({ ...details, [f.key]: e.target.value })} className={fieldClass} required maxLength={120} autoComplete="off" />
                    </Field>
                  ))}
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id={`${uid}-r`} label="Reason" hint="Kept with your name, the time and where you did this from.">
                  <select id={`${uid}-r`} value={reason.code} onChange={(e) => setReason({ ...reason, code: e.target.value })} className={fieldClass} required>
                    <option value="">Choose a reason…</option>
                    {opts.reasons.map((r) => <option key={r.code} value={r.code}>{r.description}</option>)}
                  </select>
                </Field>
                <Field id={`${uid}-rt`} label={chosenReason?.requiresComment ? 'Explain (required)' : 'Comment (optional)'}>
                  <input id={`${uid}-rt`} value={reason.text} onChange={(e) => setReason({ ...reason, text: e.target.value })} className={fieldClass} required={chosenReason?.requiresComment ?? false} maxLength={300} autoComplete="off" />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={primaryClass} disabled={busy}>Create and send on</button>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => void save(false)}>Save as draft</button>
              </div>
            </>
          ) : null}
        </form>
      )}
    </div>
  );
}
