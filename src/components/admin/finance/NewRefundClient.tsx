'use client';

import { use, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createRefundAction, type refundStartAction } from '@/server/domains/finance/refund-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { payoutFields, refundInput, refundProblem, refundRoute, startingDetails, type RefundForm } from '@/lib/refund-form';
import { needsComment } from '@/lib/receipt-detail';
import { metaValue } from '@/lib/receipt-form';
import type { Choice } from '@/lib/payment-options';
import { useCustomerCreated } from '@/components/admin/customer-created';
import { Field, LoadFailed, Message, PageHeader, cardClass, buttonClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type Start = Extract<Awaited<ReturnType<typeof refundStartAction>>, { ok: true }>['data'];

export function NewRefundClient({ startPromise }: { startPromise: ReturnType<typeof refundStartAction> }) {
  const start = use(startPromise);
  return start.ok ? <NewRefundView start={start.data} /> : <LoadFailed error={start.error} />;
}

const metaOrNull = (choice: Choice | null, key: string): string | null => {
  const v = metaValue(choice?.meta, key);
  return v === '' ? null : v;
};

function NewRefundView({ start }: { start: Start }) {
  const uid = useId();
  const router = useRouter();
  const [customer, setCustomer] = useState<Choice | null>(start.customer);
  const [source, setSource] = useState<Choice | null>(start.source);
  const [amount, setAmount] = useState(metaValue(start.source?.meta, 'available'));
  const [method, setMethod] = useState<Choice | null>(null);
  const [details, setDetails] = useState<Record<string, string>>(startingDetails(metaValue(start.customer?.meta, 'phone')));
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const nonce = useRef<string | null>(null);

  const form: RefundForm = {
    customerId: customer?.id ?? null, sourceKind: metaOrNull(source, 'kind'), sourceId: metaOrNull(source, 'sourceId'), amount, methodId: method?.id ?? null,
    details, reasonCode: reason?.id ?? null, reasonText,
  };

  const sourceCurrency = metaValue(source?.meta, 'currency');
  const sourceAvailable = metaValue(source?.meta, 'available');

  const chooseCustomer = (c: Choice | null) => {
    setCustomer(c);
    setSource(null);
    setAmount('');
    setDetails(startingDetails(metaValue(c?.meta, 'phone')));
  };
  useCustomerCreated(chooseCustomer);
  const chooseSource = (c: Choice | null) => {
    setSource(c);
    if (c !== null && amount === '') setAmount(metaValue(c.meta, 'available'));
  };

  const save = async (submit: boolean) => {
    const problem = refundProblem(form);
    if (problem !== null) {
      setNotice({ kind: 'error', text: problem });
      return;
    }
    nonce.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice(null);
    const res = await attempt(createRefundAction(refundInput(form, nonce.current) as never, submit));
    if (!res.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.push(refundRoute(res.data.id, res.data.submitError));
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="New refund" intro="Pay a customer back from something they are owed. The amount can never be more than what is left." />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-4`} aria-label="New refund" onSubmit={(e) => { e.preventDefault(); void save(true); }}>
        <ChoicePicker label="Customer" source="refund-customers" choice={customer} onChoice={chooseCustomer} clearable={false} required placeholder="Name, number or phone" listHref="/admin/customers" listLabel="View all customers" createHref="/admin/customers/new" createLabel="+ Create a customer" />
        {customer !== null ? (
          <>
            <ChoicePicker label="Refund from" source="refund-sources" filters={{ customer: customer.id }} choice={source} onChoice={chooseSource} clearable={false} required placeholder="What is the customer owed?" emptyMessage="This customer is owed nothing that can be refunded." />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${uid}-amt`} label={`Amount${sourceCurrency === '' ? '' : ` (${sourceCurrency})`}`} hint={sourceAvailable === '' ? undefined : `At most ${sourceAvailable}`}>
                <input id={`${uid}-amt`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} required />
              </Field>
              <ChoicePicker label="Pay by" source="refund-methods" choice={method} onChoice={(c) => { setMethod(c); setDetails(startingDetails(metaValue(customer.meta, 'phone'))); }} clearable={false} required placeholder="How will it be paid?" />
            </div>
            {method !== null ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {payoutFields(metaValue(method.meta, 'kind')).map((f) => (
                  <Field key={f.key} id={`${uid}-d-${f.key}`} label={f.label} hint={f.key === 'phone' && !start.canChangeDestination ? 'Only the number on the customer’s record can be used.' : undefined}>
                    <input id={`${uid}-d-${f.key}`} type={f.type ?? 'text'} value={details[f.key] ?? ''} onChange={(e) => setDetails({ ...details, [f.key]: e.target.value })} className={fieldClass} required maxLength={120} autoComplete="off" />
                  </Field>
                ))}
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ChoicePicker label="Reason" source="refund-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
              <Field id={`${uid}-rt`} label={needsComment(reason?.meta) ? 'Explain (required)' : 'Comment (optional)'} hint="Kept with your name, the time and where you did this from.">
                <input id={`${uid}-rt`} value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsComment(reason?.meta)} maxLength={300} autoComplete="off" />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={primaryClass} disabled={busy}>Create and send on</button>
              <button type="button" className={buttonClass} disabled={busy} onClick={() => void save(false)}>Save as draft</button>
            </div>
          </>
        ) : null}
      </form>
    </div>
  );
}
