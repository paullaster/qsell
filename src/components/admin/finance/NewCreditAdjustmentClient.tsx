'use client';

import { use, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { requestCreditAdjustmentAction, type creditAdjustmentStartAction } from '@/server/domains/finance/credit-adjustment-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { KIND_SENTENCE, adjustmentInput, adjustmentProblem, adjustmentRoute, isKind, type AdjustmentForm } from '@/lib/credit-adjustment-form';
import { needsComment } from '@/lib/receipt-detail';
import { trimToNull } from '@/lib/values';
import { metaValue } from '@/lib/receipt-form';
import type { Choice } from '@/lib/payment-options';
import { useCustomerCreated } from '@/components/admin/customer-created';
import { Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from './ui';

type Start = Extract<Awaited<ReturnType<typeof creditAdjustmentStartAction>>, { ok: true }>['data'];

export function NewCreditAdjustmentClient({ startPromise }: { startPromise: ReturnType<typeof creditAdjustmentStartAction> }) {
  const start = use(startPromise);
  return start.ok ? <NewCreditAdjustmentView start={start.data} /> : <LoadFailed error={start.error} />;
}

function NewCreditAdjustmentView({ start }: { start: Start }) {
  const uid = useId();
  const router = useRouter();
  const [customer, setCustomer] = useState<Choice | null>(start.customer);
  const [kind, setKind] = useState<Choice | null>(start.kind);
  const [source, setSource] = useState<Choice | null>(start.source);
  const [amount, setAmount] = useState(metaValue(start.source?.meta, 'available'));
  const [currency, setCurrency] = useState(start.currency);
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const nonce = useRef<string | null>(null);

  const kindId = isKind(kind?.id) ? kind.id : null;
  const form: AdjustmentForm = { customerId: customer?.id ?? null, kind: kindId, sourceKind: trimToNull(metaValue(source?.meta, 'kind')), sourceId: trimToNull(metaValue(source?.meta, 'sourceId')), amount, currency, reasonCode: reason?.id ?? null, reasonText };
  const available = metaValue(source?.meta, 'available');

  const chooseCustomer = (c: Choice | null) => { setCustomer(c); setSource(null); setAmount(''); };
  useCustomerCreated(chooseCustomer);

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = adjustmentProblem(form);
    if (problem !== null) { setNotice({ kind: 'error', text: problem }); return; }
    nonce.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice(null);
    const res = await attempt(requestCreditAdjustmentAction(adjustmentInput(form, nonce.current) as never));
    if (!res.ok) { setBusy(false); setNotice({ kind: 'error', text: res.error }); return; }
    router.push(adjustmentRoute(res.data.id));
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Change a customer's credit" intro="Give up credit a customer is owed, or add to or take from their wallet, without any money moving. Someone other than you has to decide it." />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-4`} aria-label="Change a customer's credit" onSubmit={(e) => void save(e)}>
        <ChoicePicker label="Customer" source="adjustment-customers" choice={customer} onChoice={chooseCustomer} clearable={false} required placeholder="Name, number or phone" listHref="/admin/customers" listLabel="View all customers" />
        {customer !== null ? (
          <>
            <ChoicePicker label="What to do" source="adjustment-kinds" choice={kind} onChoice={(c) => { setKind(c); setSource(null); }} clearable={false} required placeholder="Choose…" />
            {kindId !== null ? <p className="text-xs text-fg-muted" role="note">{KIND_SENTENCE[kindId]}</p> : null}
            {kindId === 'waive_excess' ? (
              <ChoicePicker label="Credit to give up" source="adjustment-sources" filters={{ customer: customer.id }} choice={source} onChoice={(c) => { setSource(c); if (c !== null && amount === '') setAmount(metaValue(c.meta, 'available')); }} clearable={false} required placeholder="What is the customer owed?" emptyMessage="This customer is owed nothing that can be given up." />
            ) : null}
            {kindId !== null ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field id={`${uid}-amt`} label="Amount" hint={available === '' ? undefined : `At most ${available}`}>
                    <input id={`${uid}-amt`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} required />
                  </Field>
                  {kindId !== 'waive_excess' ? (
                    <Field id={`${uid}-cur`} label="Wallet currency" hint="Leave empty for the books' own currency.">
                      <input id={`${uid}-cur`} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className={fieldClass} maxLength={3} autoComplete="off" />
                    </Field>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <ChoicePicker label="Reason" source="adjustment-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
                  <Field id={`${uid}-rt`} label={needsComment(reason?.meta) ? 'Explain (required)' : 'Comment (optional)'} hint="Kept with your name, the time and where you did this from.">
                    <input id={`${uid}-rt`} value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsComment(reason?.meta)} maxLength={300} autoComplete="off" />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="submit" className={primaryClass} disabled={busy}>Ask for it</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => router.back()}>Cancel</button>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </form>
    </div>
  );
}
