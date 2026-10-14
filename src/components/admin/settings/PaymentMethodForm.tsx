'use client';

import { useId, useState } from 'react';
import { createPaymentMethodAction, updatePaymentMethodAction } from '@/server/domains/finance/receivables/actions';
import type { paymentSetupAction } from '@/server/domains/finance/payment-setup-actions';
import { Field, Message, buttonClass, fieldClass, primaryClass, type Notice, attempt } from '../finance/ui';

type Setup = Extract<Awaited<ReturnType<typeof paymentSetupAction>>, { ok: true }>['data'];
export type SetupMethod = Setup['methods'][number];

const KINDS: [string, string][] = [
  ['cash', 'Cash'], ['bank_transfer', 'Bank transfer / EFT'], ['bank_deposit', 'Bank deposit slip'], ['cheque', 'Cheque'],
  ['mobile_money', 'Mobile money'], ['card', 'Card'], ['gateway', 'Online gateway'], ['other', 'Other'],
];
const CHANNELS: [string, string][] = [['', 'No number'], ['paybill', 'Paybill number'], ['till', 'Till number'], ['account', 'Account number'], ['other', 'Other number']];

const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

/** One payment method under one provider: where it posts, which branch, what number, what must be recorded. */
export function PaymentMethodForm({ setup, providerId, providerName, method, onDone, onCancel }: { setup: Setup; providerId: string; providerName: string; method: SetupMethod | null; onDone: (text: string) => void; onCancel: () => void }) {
  const uid = useId();
  const [name, setName] = useState(method?.name ?? '');
  const [code, setCode] = useState(method?.code ?? '');
  const [kind, setKind] = useState<string>(method?.kind ?? 'mobile_money');
  const [branchId, setBranchId] = useState(method?.branchId ?? '');
  const [bankId, setBankId] = useState(method?.bankAccountId ?? '');
  const [glId, setGlId] = useState(method?.glAccountId ?? '');
  const [channelKind, setChannelKind] = useState(method?.channelKind ?? '');
  const [channelNumber, setChannelNumber] = useState(method?.channelNumber ?? '');
  const [reqRef, setReqRef] = useState(method?.requiresReference ?? false);
  const [reqEv, setReqEv] = useState(method?.requiresEvidence ?? false);
  const [reqCp, setReqCp] = useState(method?.requiresCounterparty ?? false);
  const [refundable, setRefundable] = useState(method ? method.usableFor.includes('customer_refund') : false);
  const [refundDest, setRefundDest] = useState<'none' | 'manual' | 'automatic'>(method?.refundDestination ?? 'none');
  const [min, setMin] = useState(method?.limits.min ?? '');
  const [max, setMax] = useState(method?.limits.max ?? '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Choosing a bank account that other methods already use suggests the G/L account they post to.
  const pickBank = (id: string) => {
    setBankId(id);
    if (!glId) {
      const used = [...new Set(setup.methods.filter((m) => m.bankAccountId === id).map((m) => m.glAccountId))];
      if (used.length === 1) setGlId(used[0]!);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const limits: { min?: string; max?: string } = {};
    if (min.trim()) limits.min = min.trim();
    if (max.trim()) limits.max = max.trim();
    const body = {
      name,
      kind: kind as never,
      balancingBankAccountId: bankId,
      providerId,
      branchId: branchId || null,
      glAccountId: glId,
      channelKind: channelNumber.trim() ? channelKind || 'other' : null,
      channelNumber: channelNumber.trim() || null,
      requiresReference: reqRef,
      requiresEvidence: reqEv,
      requiresCounterparty: reqCp,
      usableFor: refundable ? ['customer_receipt', 'customer_refund'] : ['customer_receipt'],
      refundDestination: refundable ? (refundDest === 'none' ? ('manual' as const) : refundDest) : ('none' as const),
      limits,
    };
    const res = method ? await attempt(updatePaymentMethodAction(method.id, body)) : await attempt(createPaymentMethodAction({ code: code.trim() || slug(name), ...body }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    onDone(method ? `${name} saved.` : `${name} added under ${providerName}.`);
  };

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-4 rounded-xl border border-line bg-surface p-4" aria-label={method ? `Edit ${method.name}` : `New payment method under ${providerName}`}>
      <h4 className="text-sm font-bold text-fg-strong">{method ? `Edit ${method.name}` : `New payment method under ${providerName}`}</h4>
      <Message notice={notice} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-n`} label="Name" hint="What staff and customers see, e.g. “M-Pesa paybill — Nairobi”.">
          <input id={`${uid}-n`} value={name} onChange={(e) => { setName(e.target.value); if (!method && !code) setCode(''); }} className={fieldClass} required maxLength={80} autoComplete="off" />
        </Field>
        <Field id={`${uid}-c`} label="Code" hint={method ? 'The code never changes.' : 'Capital letters and digits; made from the name if left empty.'}>
          <input id={`${uid}-c`} value={method ? method.code : code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={slug(name)} className={fieldClass} disabled={!!method} maxLength={30} autoComplete="off" />
        </Field>
        <Field id={`${uid}-k`} label="Kind">
          <select id={`${uid}-k`} value={kind} onChange={(e) => setKind(e.target.value)} className={fieldClass}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </Field>
        <Field id={`${uid}-b`} label="Branch" hint="Which branch takes payments this way. Every branch if you leave it empty.">
          <select id={`${uid}-b`} value={branchId} onChange={(e) => setBranchId(e.target.value)} className={fieldClass}>
            <option value="">Every branch</option>
            {setup.branches.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </Field>
        <Field id={`${uid}-ba`} label="Bank account" hint="The real account the money lands in (its statement is reconciled).">
          <select id={`${uid}-ba`} value={bankId} onChange={(e) => pickBank(e.target.value)} className={fieldClass} required>
            <option value="">Choose…</option>
            {setup.banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </Field>
        <Field id={`${uid}-g`} label="G/L account" hint="The account the books debit when money comes in this way.">
          <select id={`${uid}-g`} value={glId} onChange={(e) => setGlId(e.target.value)} className={fieldClass} required>
            <option value="">Choose…</option>
            {setup.glChoices.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </Field>
        <Field id={`${uid}-ck`} label="Paybill, till or account">
          <select id={`${uid}-ck`} value={channelKind} onChange={(e) => setChannelKind(e.target.value)} className={fieldClass}>{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </Field>
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
          <Field id={`${uid}-rd`} label="Paid out">
            <select id={`${uid}-rd`} value={refundDest === 'none' ? 'manual' : refundDest} onChange={(e) => setRefundDest(e.target.value as 'manual')} className={fieldClass}>
              <option value="manual">By hand, with evidence</option>
              <option value="automatic">Automatically through the provider (when available)</option>
            </select>
          </Field>
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
