'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createPaymentMethodAction,
  deletePaymentMethodAction,
  linkOrdersToMethodsAction,
  seedPaymentSetupAction,
  setPaymentMethodEnabledAction,
  updatePaymentMethodAction,
  type listPaymentMethodsAction,
} from '@/server/domains/finance/receivables/actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof listPaymentMethodsAction>>, { ok: true }>['data'];
type Method = View['methods'][number];
type Kind = Method['kind'];

const KINDS: [Kind, string][] = [
  ['cash', 'Cash'], ['bank_transfer', 'Bank transfer / EFT'], ['bank_deposit', 'Bank deposit slip'], ['cheque', 'Cheque'],
  ['mobile_money', 'Mobile money'], ['card', 'Card'], ['gateway', 'Online gateway'], ['wallet', 'Customer wallet'],
  ['gift_card', 'Gift card'], ['offset', 'Offset / contra'], ['other', 'Other'],
];
const USES: [string, string][] = [
  ['customer_receipt', 'Receive money from customers'],
  ['customer_refund', 'Refund customers'],
  ['vendor_payment', 'Pay suppliers'],
  ['vendor_receipt', 'Receive from suppliers'],
];

interface FormState {
  id: string | null;
  code: string;
  name: string;
  kind: Kind;
  bankAccountId: string;
  requiresReference: boolean;
  requiresEvidence: boolean;
  requiresCounterparty: boolean;
  collectProviderConfigId: string;
  usableFor: string[];
  min: string;
  max: string;
  refundDestination: 'none' | 'manual' | 'automatic';
  legacyCodes: string;
  sortOrder: string;
}

const blank = (): FormState => ({
  id: null, code: '', name: '', kind: 'cash', bankAccountId: '', requiresReference: false, requiresEvidence: false, requiresCounterparty: false,
  collectProviderConfigId: '', usableFor: ['customer_receipt'], min: '', max: '', refundDestination: 'none', legacyCodes: '', sortOrder: '100',
});

export function PaymentMethodsClient({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const edit = (m: Method) =>
    setForm({
      id: m.id, code: m.code, name: m.name, kind: m.kind, bankAccountId: m.bankAccountId, requiresReference: m.requiresReference,
      requiresEvidence: m.requiresEvidence, requiresCounterparty: m.requiresCounterparty, collectProviderConfigId: m.collectProviderConfigId ?? '',
      usableFor: m.usableFor, min: m.limits.min ?? '', max: m.limits.max ?? '', refundDestination: m.refundDestination,
      legacyCodes: m.legacyCodes.join(', '), sortOrder: String(m.sortOrder),
    });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setNotice(null);
    const limits: { min?: string; max?: string } = {};
    if (form.min.trim()) limits.min = form.min.trim();
    if (form.max.trim()) limits.max = form.max.trim();
    const body = {
      name: form.name,
      kind: form.kind,
      balancingBankAccountId: form.bankAccountId,
      requiresReference: form.requiresReference,
      requiresEvidence: form.requiresEvidence,
      requiresCounterparty: form.requiresCounterparty,
      collectProviderConfigId: form.collectProviderConfigId || null,
      usableFor: form.usableFor,
      limits,
      refundDestination: form.refundDestination,
      legacyCodes: form.legacyCodes.split(',').map((s) => s.trim()).filter(Boolean),
      sortOrder: Number(form.sortOrder) || 100,
    };
    const res = form.id
      ? await attempt(updatePaymentMethodAction(form.id, body))
      : await attempt(createPaymentMethodAction({ code: form.code.trim().toUpperCase(), ...body }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: form.id ? 'Payment method saved.' : 'Payment method added.' });
    setForm(null);
    router.refresh();
  };

  const toggle = async (m: Method) => {
    setBusy(true);
    const res = await attempt(setPaymentMethodEnabledAction(m.id, !m.enabled));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: m.enabled ? `${m.name} is switched off.` : `${m.name} is switched on.` } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  const remove = async (id: string) => {
    setBusy(true);
    const res = await attempt(deletePaymentMethodAction(id));
    setBusy(false);
    setConfirmDelete(null);
    setNotice(res.ok ? { kind: 'ok', text: 'Payment method deleted.' } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  const seed = async () => {
    setBusy(true);
    const res = await attempt(seedPaymentSetupAction());
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: `Added ${res.data.bankAccounts} bank accounts and ${res.data.methods} payment methods.` } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  const link = async () => {
    setBusy(true);
    const res = await attempt(linkOrdersToMethodsAction());
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: res.data.linked === 0 ? 'Every order that can be linked already is.' : `Linked ${res.data.linked} past orders to their payment method.` } : { kind: 'error', text: res.error });
  };

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Payment methods"
        intro="How customers pay, and what that does to the books. A method decides which bank or cash account the money lands in, what must be recorded (a transaction code, a cheque's details, evidence), and which provider collects it. Providers are connections; methods are your rules."
        actions={
          <>
            {view.methods.length === 0 && view.can.seed ? <button type="button" className={buttonClass} disabled={busy} onClick={seed}>Add the standard accounts and methods</button> : null}
            {view.can.linkOrders && view.methods.length > 0 ? <button type="button" className={buttonClass} disabled={busy} onClick={link}>Link past orders</button> : null}
            {view.can.create ? <button type="button" className={primaryClass} aria-expanded={form !== null} onClick={() => setForm(form ? null : blank())}>Add method</button> : null}
          </>
        }
      />
      <Message notice={notice} />

      {form ? (
        <form onSubmit={save} className={`${cardClass} space-y-4`} aria-label={form.id ? `Edit ${form.code}` : 'Add a payment method'}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field id={`${uid}-code`} label="Code" hint={form.id ? 'A code does not change.' : 'Capital letters and digits, e.g. AIRTEL.'}>
              <input id={`${uid}-code`} value={form.code} onChange={(e) => set('code', e.target.value)} className={fieldClass} required disabled={form.id !== null} maxLength={30} autoComplete="off" />
            </Field>
            <Field id={`${uid}-name`} label="Name"><input id={`${uid}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} required maxLength={80} /></Field>
            <Field id={`${uid}-kind`} label="Kind">
              <select id={`${uid}-kind`} value={form.kind} onChange={(e) => set('kind', e.target.value as Kind)} className={fieldClass}>
                {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-bank`} label="Pays into" hint="The bank, cash or clearing account the money lands in.">
              <select id={`${uid}-bank`} value={form.bankAccountId} onChange={(e) => set('bankAccountId', e.target.value)} className={fieldClass} required>
                <option value="">Choose…</option>
                {view.banks.filter((b) => !b.blocked || b.id === form.bankAccountId).map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-prov`} label="Collected by provider" hint="Optional. A method with no provider is recorded by hand (cash, cheque).">
              <select id={`${uid}-prov`} value={form.collectProviderConfigId} onChange={(e) => set('collectProviderConfigId', e.target.value)} className={fieldClass}>
                <option value="">None (manual)</option>
                {view.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-refund`} label="Refunds through this method">
              <select id={`${uid}-refund`} value={form.refundDestination} onChange={(e) => set('refundDestination', e.target.value as FormState['refundDestination'])} className={fieldClass}>
                <option value="none">Not allowed</option>
                <option value="manual">Manual (a person pays out and records it)</option>
                <option value="automatic">Automatic (through the provider)</option>
              </select>
            </Field>
            <Field id={`${uid}-min`} label="Smallest amount"><input id={`${uid}-min`} value={form.min} onChange={(e) => set('min', e.target.value)} className={fieldClass} inputMode="decimal" placeholder="No minimum" /></Field>
            <Field id={`${uid}-max`} label="Largest amount"><input id={`${uid}-max`} value={form.max} onChange={(e) => set('max', e.target.value)} className={fieldClass} inputMode="decimal" placeholder="No maximum" /></Field>
            <Field id={`${uid}-sort`} label="Order in lists"><input id={`${uid}-sort`} value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} className={fieldClass} inputMode="numeric" /></Field>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-fg">When a receipt uses this method, require</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {([
                ['requiresReference', 'The payment reference (transaction code, slip or bank reference)'],
                ['requiresCounterparty', "A cheque's number, the drawer's bank and the drawer"],
                ['requiresEvidence', 'Evidence attached before posting (deposit slip, screenshot, cheque image)'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex min-h-10 items-center gap-2 text-sm text-fg">
                  <input type="checkbox" checked={form[key]} onChange={(e) => set(key, e.target.checked)} className="h-4 w-4" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-fg">This method can be used to</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {USES.map(([v, l]) => (
                <label key={v} className="flex min-h-10 items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={form.usableFor.includes(v)}
                    onChange={(e) => set('usableFor', e.target.checked ? [...form.usableFor, v] : form.usableFor.filter((x) => x !== v))}
                    className="h-4 w-4"
                  />
                  {l}
                </label>
              ))}
            </div>
          </fieldset>

          <Field id={`${uid}-legacy`} label="Old provider codes it stands for" hint="Orders placed with these codes (e.g. mpesa_daraja) are linked to this method. Separate with commas.">
            <input id={`${uid}-legacy`} value={form.legacyCodes} onChange={(e) => set('legacyCodes', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy}>{form.id ? 'Save changes' : 'Add method'}</button>
            <button type="button" className={buttonClass} onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {view.methods.length === 0 ? (
        <p className="text-sm text-fg-muted">No payment methods yet.{view.can.seed ? ' Add the standard set above, or add your own.' : ''}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {view.methods.map((m) => (
            <li key={m.id} className={`${cardClass} flex flex-col gap-3 ${m.enabled ? '' : 'opacity-70'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-fg-strong">{m.name}</p>
                  <p className="text-xs text-fg-muted">{m.code} · {KINDS.find(([k]) => k === m.kind)?.[1]}</p>
                </div>
                {m.enabled ? <Chip tone="green">On</Chip> : <Chip tone="gray">Off</Chip>}
              </div>
              <dl className="space-y-1 text-xs">
                <div className="flex justify-between gap-2"><dt className="text-fg-muted">Pays into</dt><dd className="text-right font-semibold text-fg-strong">{m.bankLabel}{m.bankBlocked ? ' (blocked)' : ''}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-fg-muted">Provider</dt><dd className="text-right font-semibold text-fg-strong">{m.providerLabel ?? 'None (manual)'}{m.providerLabel && !m.providerEnabled ? ' (off)' : ''}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-1">
                {m.requiresReference ? <Chip tone="sky">Reference</Chip> : null}
                {m.requiresCounterparty ? <Chip tone="sky">Cheque details</Chip> : null}
                {m.requiresEvidence ? <Chip tone="sky">Evidence</Chip> : null}
                {m.refundDestination !== 'none' ? <Chip tone="gray">Refunds: {m.refundDestination}</Chip> : null}
                {m.legacyCodes.length ? <Chip tone="gray">Orders: {m.legacyCodes.join(', ')}</Chip> : null}
              </div>
              <div className="mt-auto flex flex-wrap gap-2">
                {view.can.edit ? <button type="button" className={buttonClass} onClick={() => edit(m)} aria-label={`Edit ${m.name}`}>Edit</button> : null}
                {view.can.disable ? <button type="button" className={buttonClass} disabled={busy} onClick={() => toggle(m)} aria-label={`${m.enabled ? 'Switch off' : 'Switch on'} ${m.name}`}>{m.enabled ? 'Switch off' : 'Switch on'}</button> : null}
                {view.can.delete ? (
                  confirmDelete === m.id ? (
                    <>
                      <button type="button" className={dangerClass} disabled={busy} onClick={() => remove(m.id)}>Confirm delete</button>
                      <button type="button" className={buttonClass} onClick={() => setConfirmDelete(null)}>Keep</button>
                    </>
                  ) : (
                    <button type="button" className={dangerClass} onClick={() => setConfirmDelete(m.id)} aria-label={`Delete ${m.name}`}>Delete</button>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
