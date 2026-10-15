'use client';

import { use, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createReceiptAction, type receiptFormOptionsAction, type receiptPresetCustomerAction } from '@/server/domains/finance/receivables/actions';
import type { walletFormOptionsAction } from '@/server/domains/finance/wallet-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { amountHint, customerStanding, isForeign, methodTraits, postOptions, receiptInput, receiptProblem, receiptRoute, type ReceiptForm } from '@/lib/receipt-form';
import type { Choice } from '@/lib/payment-options';
import { useCustomerCreated } from '@/components/admin/customer-created';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, money, primaryClass, today, type Notice, attempt } from './ui';

type Wallet = { enabled: boolean; label: string; canDeposit: boolean } | null;

interface Props {
  optionsPromise: ReturnType<typeof receiptFormOptionsAction>;
  presetPromise: Promise<Awaited<ReturnType<typeof receiptPresetCustomerAction>> | null>;
  walletPromise: ReturnType<typeof walletFormOptionsAction>;
}

export function NewReceiptClient({ optionsPromise, presetPromise, walletPromise }: Props) {
  const options = use(optionsPromise);
  const preset = use(presetPromise);
  const wallet = use(walletPromise);
  if (!options.ok) return <LoadFailed error={options.error} />;
  return <NewReceiptView baseCurrency={options.data.baseCurrency} presetCustomer={preset?.ok === true ? preset.data : null} wallet={wallet.ok ? wallet.data : null} />;
}

function NewReceiptView({ baseCurrency, presetCustomer, wallet }: { baseCurrency: string; presetCustomer: Choice | null; wallet: Wallet }) {
  const uid = useId();
  const router = useRouter();
  const [customer, setCustomer] = useState<Choice | null>(presetCustomer);
  useCustomerCreated(setCustomer);
  const [method, setMethod] = useState<Choice | null>(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [payer, setPayer] = useState('');
  const [cheque, setCheque] = useState({ chequeNo: '', bank: '', drawer: '', chequeDate: '' });
  const [narration, setNarration] = useState('');
  const [rate, setRate] = useState('');
  const [allocate, setAllocate] = useState<'oldest_first' | 'none'>('oldest_first');
  const [deposit, setDeposit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const idem = useRef<string | null>(null);

  const traits = methodTraits(method?.meta);
  const foreign = isForeign(traits, baseCurrency);
  const form: ReceiptForm = {
    customerId: customer?.id ?? null, methodId: method?.id ?? null, traits, amount, date, reference, payer, cheque, narration, rate, deposit, allocate,
  };

  const submit = async (post: boolean) => {
    const problem = receiptProblem(form);
    if (problem !== null) {
      setNotice({ kind: 'error', text: problem });
      return;
    }
    // One key per form, made when first needed, so a retry of the same receipt cannot make two.
    idem.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice(null);
    const created = await attempt(createReceiptAction(receiptInput(form, idem.current, baseCurrency), postOptions(form, post)));
    if (!created.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: created.error });
      return;
    }
    router.push(receiptRoute(created.data.id, post ? created.data.postError : null));
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="New receipt" intro="Record money a customer has paid. Nothing reaches the books until the receipt is posted." />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-5`} aria-label="New receipt" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
        <div className="space-y-1">
          <ChoicePicker label="Customer" source="receipt-customers" choice={customer} onChoice={setCustomer} clearable={false} required placeholder="Type a name, number, phone or email" listHref="/admin/customers" listLabel="View all customers" createHref="/admin/customers/new" createLabel="+ Create a customer" />
          {customer !== null ? <p className="text-xs text-fg-muted">{customerStanding(customer.meta, money)}</p> : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ChoicePicker label="Payment method" source="receipt-methods" choice={method} onChoice={setMethod} clearable={false} required placeholder="How did the customer pay?" />
          <Field id={`${uid}-amount`} label={`Amount${traits !== null && traits.currency !== '' ? ` (${traits.currency})` : ''}`} hint={amountHint(traits)}>
            <input id={`${uid}-amount`} value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldClass} inputMode="decimal" required placeholder="0.00" autoComplete="off" />
          </Field>
          <Field id={`${uid}-date`} label="Date paid">
            <input id={`${uid}-date`} type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} className={fieldClass} required />
          </Field>
          <Field
            id={`${uid}-ref`}
            label={`Payment reference${traits?.requiresReference === true ? '' : ' (optional)'}`}
            hint={traits?.requiresReference === true ? 'The M-Pesa code, bank reference or slip number. The same reference cannot be recorded twice.' : undefined}
          >
            <input id={`${uid}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} className={fieldClass} required={traits?.requiresReference === true} autoComplete="off" />
          </Field>
          <Field id={`${uid}-payer`} label="Paid by (if not the customer)">
            <input id={`${uid}-payer`} value={payer} onChange={(e) => setPayer(e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          {foreign ? (
            <Field id={`${uid}-rate`} label={`Exchange rate to ${baseCurrency}`} hint={`How many ${baseCurrency} one ${traits?.currency ?? ''} is worth today.`}>
              <input id={`${uid}-rate`} value={rate} onChange={(e) => setRate(e.target.value)} className={fieldClass} inputMode="decimal" required />
            </Field>
          ) : null}
        </div>

        {traits?.requiresCounterparty === true ? (
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

        {wallet !== null && wallet.enabled && wallet.canDeposit ? (
          <label className="flex min-h-10 items-start gap-2 text-sm text-fg">
            <input type="checkbox" checked={deposit} onChange={(e) => setDeposit(e.target.checked)} className="mt-1 h-4 w-4" />
            <span><strong>Advance deposit</strong>: not for any invoice; keep all of it in the customer&apos;s {wallet.label.toLowerCase()}.</span>
          </label>
        ) : null}

        <fieldset className={`space-y-1 ${deposit ? 'hidden' : ''}`}>
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

        {traits?.requiresEvidence === true ? (
          <p className="flex items-start gap-2 text-sm text-amber-700">
            <Chip tone="amber">Evidence needed</Chip>
            <span>This method needs a photo attached before it can be posted. Save the draft, attach it on the next page, then post.</span>
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass} disabled={busy || customer === null || method === null}>Save as draft</button>
          <button type="button" className={primaryClass} disabled={busy || customer === null || method === null || traits?.requiresEvidence === true} onClick={() => void submit(true)}>
            {busy ? 'Saving…' : 'Save and post'}
          </button>
        </div>
      </form>
    </div>
  );
}
