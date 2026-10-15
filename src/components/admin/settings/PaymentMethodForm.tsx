'use client';

import { useId, useState } from 'react';
import { createPaymentMethodAction, updatePaymentMethodAction } from '@/server/domains/finance/receivables/actions';
import type { paymentSetupAction } from '@/server/domains/finance/payment-setup-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { CHANNEL_KINDS, MANUAL_OR_AUTOMATIC_REFUND, METHOD_KINDS, labelOf, refundDestination, suggestGlAccount, type Choice } from '@/lib/payment-options';
import { Field, Message, buttonClass, fieldClass, primaryClass, type Notice, attempt } from '../finance/ui';

type Setup = Extract<Awaited<ReturnType<typeof paymentSetupAction>>, { ok: true }>['data'];
export type SetupMethod = Setup['methods'][number];

const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

/** One payment method under one provider: where it posts, which branch, what number, what must be recorded. */
export function PaymentMethodForm({ setup, providerId, providerName, method, onDone, onCancel }: { setup: Setup; providerId: string; providerName: string; method: SetupMethod | null; onDone: (text: string) => void; onCancel: () => void }) {
  const uid = useId();
  const [name, setName] = useState(method?.name ?? '');
  const [code, setCode] = useState(method?.code ?? '');
  const [kind, setKind] = useState<Choice | null>({ id: method?.kind ?? 'mobile_money', label: labelOf(METHOD_KINDS, method?.kind ?? 'mobile_money') ?? '' });
  const [branch, setBranch] = useState<Choice | null>(method?.branchId == null ? null : { id: method.branchId, label: method.branchName ?? method.branchId });
  const [bank, setBank] = useState<Choice | null>(method ? { id: method.bankAccountId, label: method.bankLabel } : null);
  const [gl, setGl] = useState<Choice | null>(method ? { id: method.glAccountId, label: method.glLabel } : null);
  const [channelKind, setChannelKind] = useState<Choice | null>(method?.channelKind == null ? null : { id: method.channelKind, label: labelOf(CHANNEL_KINDS, method.channelKind) ?? method.channelKind });
  const [channelNumber, setChannelNumber] = useState(method?.channelNumber ?? '');
  const [reqRef, setReqRef] = useState(method?.requiresReference ?? false);
  const [reqEv, setReqEv] = useState(method?.requiresEvidence ?? false);
  const [reqCp, setReqCp] = useState(method?.requiresCounterparty ?? false);
  const [refundable, setRefundable] = useState(method ? method.usableFor.includes('customer_refund') : false);
  const [refundDest, setRefundDest] = useState<Choice | null>({ id: method?.refundDestination === 'automatic' ? 'automatic' : 'manual', label: labelOf(MANUAL_OR_AUTOMATIC_REFUND, method?.refundDestination === 'automatic' ? 'automatic' : 'manual') ?? '' });
  const [min, setMin] = useState(method?.limits.min ?? '');
  const [max, setMax] = useState(method?.limits.max ?? '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Choosing a bank account that other methods already use suggests the G/L account they post to.
  const pickBank = (choice: Choice | null) => {
    setBank(choice);
    if (choice && !gl) setGl(suggestGlAccount(setup.methods, choice.id));
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const limits: { min?: string; max?: string } = {};
    if (min.trim() !== '') limits.min = min.trim();
    if (max.trim() !== '') limits.max = max.trim();
    const body = {
      name,
      kind: (kind?.id ?? 'other') as never,
      balancingBankAccountId: bank?.id ?? '',
      providerId,
      branchId: branch?.id ?? null,
      glAccountId: gl?.id ?? '',
      channelKind: channelNumber.trim() === '' ? null : (channelKind?.id ?? 'other'),
      channelNumber: channelNumber.trim() === '' ? null : channelNumber.trim(),
      requiresReference: reqRef,
      requiresEvidence: reqEv,
      requiresCounterparty: reqCp,
      usableFor: refundable ? ['customer_receipt', 'customer_refund'] : ['customer_receipt'],
      refundDestination: refundDestination(refundable, refundDest?.id),
      limits,
    };
    const res = method ? await attempt(updatePaymentMethodAction(method.id, body)) : await attempt(createPaymentMethodAction({ code: code.trim() === '' ? slug(name) : code.trim(), ...body }));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    onDone(method ? `${name} saved.` : `${name} added under ${providerName}.`);
  };

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-4 rounded-xl border border-line bg-surface p-4" aria-label={method ? `Edit ${method.name}` : `New payment method under ${providerName}`}>
      <h4 className="text-sm font-bold text-fg-strong">{method ? `Edit ${method.name}` : `New payment method under ${providerName}`}</h4>
      <Message notice={notice} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-n`} label="Name" hint="What staff and customers see, e.g. “M-Pesa paybill — Nairobi”.">
          <input id={`${uid}-n`} value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} required maxLength={80} autoComplete="off" />
        </Field>
        <Field id={`${uid}-c`} label="Code" hint={method ? 'The code never changes.' : 'Capital letters and digits; made from the name if left empty.'}>
          <input id={`${uid}-c`} value={method ? method.code : code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={slug(name)} className={fieldClass} disabled={Boolean(method)} maxLength={30} autoComplete="off" />
        </Field>
        <ChoicePicker label="Kind" source="payment-method-kinds" choice={kind} onChoice={setKind} clearable={false} required />
        <ChoicePicker label="Branch" source="branches" choice={branch} onChoice={setBranch} placeholder="Every branch" emptyMessage="No branches match" />
        <ChoicePicker label="Bank account" source="bank-accounts" choice={bank} onChoice={pickBank} clearable={false} required />
        <ChoicePicker label="G/L account" source="asset-gl-accounts" choice={gl} onChoice={setGl} clearable={false} required />
        <ChoicePicker label="Paybill, till or account" source="payment-channel-kinds" choice={channelKind} onChoice={setChannelKind} placeholder="No number" />
        <Field id={`${uid}-cn`} label="Number">
          <input id={`${uid}-cn`} value={channelNumber} onChange={(e) => setChannelNumber(e.target.value)} className={fieldClass} maxLength={40} inputMode="numeric" autoComplete="off" />
        </Field>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-xs font-bold uppercase text-fg-muted">What must be recorded</legend>
        <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={reqRef} onChange={(e) => setReqRef(e.target.checked)} /> A transaction reference (M-Pesa code, bank reference)</label>
        <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={reqEv} onChange={(e) => setReqEv(e.target.checked)} /> Evidence (slip, screenshot)</label>
        <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={reqCp} onChange={(e) => setReqCp(e.target.checked)} /> The payer&apos;s details (cheque number, bank, drawer)</label>
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs font-bold uppercase text-fg-muted">Refunds</legend>
        <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={refundable} onChange={(e) => setRefundable(e.target.checked)} /> Customers can be refunded through this method</label>
        {refundable ? (
          <ChoicePicker label="Paid out" source="refund-payout-modes" choice={refundDest} onChoice={setRefundDest} clearable={false} required />
        ) : null}
      </fieldset>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-mn`} label="Smallest payment (optional)"><input id={`${uid}-mn`} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} className={fieldClass} /></Field>
        <Field id={`${uid}-mx`} label="Largest payment (optional)"><input id={`${uid}-mx`} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} className={fieldClass} /></Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy}>{method ? 'Save' : 'Add method'}</button>
        <button type="button" className={buttonClass} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
