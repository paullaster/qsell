'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createReceiptAction,
  searchCustomersForReceiptAction,
  type receiptFormOptionsAction,
} from '@/server/domains/finance/receivables/actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, fieldClass, money, primaryClass, today, type Notice, attempt } from './ui';

type Options = Extract<Awaited<ReturnType<typeof receiptFormOptionsAction>>, { ok: true }>['data'];
interface Found { id: string; number: string; name: string; phone: string | null; email: string | null; accountType: string; balance: string }

export function NewReceiptClient({ options, presetCustomer }: { options: Options; presetCustomer: Found | null }) {
  const uid = useId();
  const router = useRouter();
  const [customer, setCustomer] = useState<Found | null>(presetCustomer);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [methodId, setMethodId] = useState(options.methods[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [payer, setPayer] = useState('');
  const [cheque, setCheque] = useState({ chequeNo: '', bank: '', drawer: '', chequeDate: '' });
  const [narration, setNarration] = useState('');
  const [rate, setRate] = useState('');
  const [allocate, setAllocate] = useState<'oldest_first' | 'none'>('oldest_first');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const idem = useRef(crypto.randomUUID());
  const seq = useRef(0);

  // Results only count while there is something typed to match them.
  const shown = q.trim().length >= 2 ? found : [];
  const method = options.methods.find((m) => m.id === methodId);
  const foreign = method ? method.currency !== options.baseCurrency : false;

  // Look customers up as the person types (a short pause, and only the latest answer is used).
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ticket = ++seq.current;
    const t = setTimeout(() => {
      void (async () => {
        const res = await attempt(searchCustomersForReceiptAction(term));
        if (ticket !== seq.current) return;
        if (res.ok) {
          setFound(res.data);
          setActive(0);
          setOpen(true);
        }
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const choose = (c: Found) => {
    setCustomer(c);
    setQ('');
    setOpen(false);
    setFound([]);
  };

  const submit = async (post: boolean) => {
    if (!customer) return setNotice({ kind: 'error', text: 'Choose the customer who paid.' });
    if (!method) return setNotice({ kind: 'error', text: 'Choose how the customer paid.' });
    setBusy(true);
    setNotice(null);
    const created = await attempt(
      createReceiptAction(
        {
          customerId: customer.id,
          paymentMethodId: method.id,
          amount: amount.trim(),
          paymentDate: date,
          currency: method.currency,
          rate: foreign ? rate.trim() : undefined,
          externalReference: reference.trim() || null,
          payerName: payer.trim() || null,
          counterparty: method.requiresCounterparty ? cheque : {},
          narration: narration.trim() || null,
          idempotencyKey: idem.current,
        },
        post ? { allocate } : undefined,
      ),
    );
    if (!created.ok) {
      setBusy(false);
      return setNotice({ kind: 'error', text: created.error });
    }
    if (post && created.data.postError !== null) {
      // The draft exists: take the person to it, where the problem can be fixed.
      router.push(`/admin/finance/receipts/${created.data.id}?posting_failed=${encodeURIComponent(created.data.postError)}`);
      return;
    }
    router.push(`/admin/finance/receipts/${created.data.id}`);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="New receipt" intro="Record money a customer has paid. Nothing reaches the books until the receipt is posted." />
      <Message notice={notice} />
      <form
        className={`${cardClass} space-y-5`}
        aria-label="New receipt"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <div>
          <label htmlFor={`${uid}-cust`} className="mb-1 block text-xs font-semibold text-fg">Customer</label>
          {customer ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-fg-strong">{customer.name} <span className="font-normal text-fg-muted">{customer.number}</span></p>
                <p className="text-xs text-fg-muted">
                  {customer.accountType === 'credit' ? `Credit customer · owes ${money(customer.balance)}` : 'Cash customer'}
                </p>
              </div>
              <button type="button" className={buttonClass} onClick={() => setCustomer(null)}>Change</button>
            </div>
          ) : (
            <div className="relative">
              <input
                id={`${uid}-cust`}
                role="combobox"
                aria-expanded={open && shown.length > 0}
                aria-controls={`${uid}-list`}
                aria-autocomplete="list"
                aria-activedescendant={open && shown[active] ? `${uid}-opt-${active}` : undefined}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (!open || shown.length === 0) return;
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                  else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]!); }
                  else if (e.key === 'Escape') setOpen(false);
                }}
                className={fieldClass}
                placeholder="Type a name, number, phone or email"
                autoComplete="off"
              />
              {open && shown.length > 0 ? (
                <ul id={`${uid}-list`} role="listbox" aria-label="Matching customers" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface-raised shadow-lg">
                  {shown.map((c, i) => (
                    <li
                      key={c.id}
                      id={`${uid}-opt-${i}`}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => { e.preventDefault(); choose(c); }}
                      className={`flex min-h-11 cursor-pointer flex-col justify-center px-3 py-1.5 text-sm ${i === active ? 'bg-hover' : ''}`}
                    >
                      <span className="font-semibold text-fg-strong">{c.name} <span className="font-normal text-fg-muted">{c.number}</span></span>
                      <span className="text-xs text-fg-muted">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-1 text-[11px] text-fg-muted" aria-live="polite">{q.trim().length >= 2 && shown.length === 0 ? 'No customer matches.' : ' '}</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id={`${uid}-method`} label="Payment method">
            <select id={`${uid}-method`} value={methodId} onChange={(e) => setMethodId(e.target.value)} className={fieldClass} required>
              {options.methods.length === 0 ? <option value="">No payment methods set up</option> : null}
              {options.methods.map((m) => <option key={m.id} value={m.id}>{m.name} → {m.bankLabel}</option>)}
            </select>
          </Field>
          <Field id={`${uid}-amount`} label={`Amount${method ? ` (${method.currency})` : ''}`} hint={method?.limits.min || method?.limits.max ? `Allowed: ${method.limits.min ?? '0'} to ${method.limits.max ?? 'no limit'}` : undefined}>
            <input id={`${uid}-amount`} value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} inputMode="decimal" required placeholder="0.00" autoComplete="off" />
          </Field>
          <Field id={`${uid}-date`} label="Date paid">
            <input id={`${uid}-date`} type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} className={fieldClass} required />
          </Field>
          <Field
            id={`${uid}-ref`}
            label={`Payment reference${method?.requiresReference ? '' : ' (optional)'}`}
            hint={method?.requiresReference ? 'The M-Pesa code, bank reference or slip number. The same reference cannot be recorded twice.' : undefined}
          >
            <input id={`${uid}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} className={fieldClass} required={method?.requiresReference ?? false} autoComplete="off" />
          </Field>
          <Field id={`${uid}-payer`} label="Paid by (if not the customer)">
            <input id={`${uid}-payer`} value={payer} onChange={(e) => setPayer(e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          {foreign ? (
            <Field id={`${uid}-rate`} label={`Exchange rate to ${options.baseCurrency}`} hint={`How many ${options.baseCurrency} one ${method?.currency} is worth today.`}>
              <input id={`${uid}-rate`} value={rate} onChange={(e) => setRate(e.target.value)} className={fieldClass} inputMode="decimal" required />
            </Field>
          ) : null}
        </div>

        {method?.requiresCounterparty ? (
          <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <legend className="mb-1 text-xs font-semibold text-fg">Cheque details</legend>
            <Field id={`${uid}-chq`} label="Cheque number"><input id={`${uid}-chq`} value={cheque.chequeNo} onChange={(e) => setCheque({ ...cheque, chequeNo: e.target.value })} className={fieldClass} required autoComplete="off" /></Field>
            <Field id={`${uid}-chqdate`} label="Date on the cheque"><input id={`${uid}-chqdate`} type="date" value={cheque.chequeDate} onChange={(e) => setCheque({ ...cheque, chequeDate: e.target.value })} className={fieldClass} /></Field>
            <Field id={`${uid}-chqbank`} label="Drawer's bank"><input id={`${uid}-chqbank`} value={cheque.bank} onChange={(e) => setCheque({ ...cheque, bank: e.target.value })} className={fieldClass} required autoComplete="off" /></Field>
            <Field id={`${uid}-chqdrawer`} label="Drawer (who wrote it)"><input id={`${uid}-chqdrawer`} value={cheque.drawer} onChange={(e) => setCheque({ ...cheque, drawer: e.target.value })} className={fieldClass} required autoComplete="off" /></Field>
          </fieldset>
        ) : null}

        <Field id={`${uid}-note`} label="Notes (optional)">
          <textarea id={`${uid}-note`} value={narration} onChange={(e) => setNarration(e.target.value)} className={`${fieldClass} min-h-20`} maxLength={500} />
        </Field>

        <fieldset className="space-y-1">
          <legend className="text-xs font-semibold text-fg">When posted</legend>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
            <input type="radio" name={`${uid}-alloc`} checked={allocate === 'oldest_first'} onChange={() => setAllocate('oldest_first')} className="h-4 w-4" />
            Apply to the customer&apos;s oldest unpaid invoices first
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
            <input type="radio" name={`${uid}-alloc`} checked={allocate === 'none'} onChange={() => setAllocate('none')} className="h-4 w-4" />
            Leave it unapplied; I will choose the invoices
          </label>
        </fieldset>

        {method?.requiresEvidence ? (
          <p className="flex items-start gap-2 text-sm text-amber-700">
            <Chip tone="amber">Evidence needed</Chip>
            <span>This method needs a photo attached before it can be posted. Save the draft, attach it on the next page, then post.</span>
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass} disabled={busy || !customer || !method}>Save as draft</button>
          <button type="button" className={primaryClass} disabled={busy || !customer || !method || method.requiresEvidence} onClick={() => void submit(true)}>
            {busy ? 'Saving…' : 'Save and post'}
          </button>
        </div>
      </form>
    </div>
  );
}
