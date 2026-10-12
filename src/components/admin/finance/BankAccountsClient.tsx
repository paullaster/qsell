'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  bankLedgerAction,
  blockBankAccountAction,
  createBankAccountAction,
  deleteBankAccountAction,
  seedPaymentSetupAction,
  updateBankAccountAction,
  type listBankAccountsAction,
} from '@/server/domains/finance/receivables/actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof listBankAccountsAction>>, { ok: true }>['data'];
type Account = View['accounts'][number];
type Kind = 'bank' | 'cash' | 'mobile_money' | 'clearing';

const KINDS: Record<Kind, string> = {
  bank: 'Bank account',
  cash: 'Cash (till or drawer)',
  mobile_money: 'Mobile-money account (paybill, till)',
  clearing: 'Clearing account (money on its way)',
};

interface FormState {
  id: string | null;
  code: string;
  name: string;
  kind: Kind;
  currency: string;
  glAccountId: string;
  feeGlAccountId: string;
  providerConfigId: string;
  bankName: string;
  accountNumber: string;
  paybill: string;
}

const blank = (currency: string): FormState => ({
  id: null, code: '', name: '', kind: 'bank', currency, glAccountId: '', feeGlAccountId: '', providerConfigId: '', bankName: '', accountNumber: '', paybill: '',
});

export function BankAccountsClient({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [movements, setMovements] = useState<{ account: { code: string; name: string; currency: string }; entries: { id: string; postingDate: string; documentType: string; documentNo: string; description: string | null; amount: string; running: string }[] } | null>(null);

  const assets = view.glChoices.filter((a) => a.category === 'assets');
  const expenses = view.glChoices.filter((a) => a.category === 'expense');
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const edit = (a: Account) =>
    setForm({
      id: a.id, code: a.code, name: a.name, kind: a.kind, currency: a.currency, glAccountId: a.glAccountId,
      feeGlAccountId: a.feeGlAccountId ?? '', providerConfigId: a.providerConfigId ?? '',
      bankName: a.details.bankName ?? '', accountNumber: a.details.accountNumber ?? '', paybill: a.details.paybill ?? '',
    });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setNotice(null);
    const details: Record<string, string> = {};
    if (form.bankName.trim()) details.bankName = form.bankName.trim();
    if (form.accountNumber.trim()) details.accountNumber = form.accountNumber.trim();
    if (form.paybill.trim()) details.paybill = form.paybill.trim();
    const common = {
      name: form.name,
      kind: form.kind,
      currency: form.currency.toUpperCase(),
      glAccountId: form.glAccountId,
      feeGlAccountId: form.feeGlAccountId || null,
      providerConfigId: form.providerConfigId || null,
      details,
    };
    const res = form.id
      ? await attempt(updateBankAccountAction(form.id, common))
      : await attempt(createBankAccountAction({ code: form.code.trim().toUpperCase(), ...common }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: form.id ? 'Bank account saved.' : 'Bank account added.' });
    setForm(null);
    router.refresh();
  };

  const toggleBlock = async (a: Account) => {
    setBusy(true);
    const res = await attempt(blockBankAccountAction(a.id, !a.blocked));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: a.blocked ? `${a.code} is open again.` : `${a.code} is blocked: nothing can be received into it.` } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  const remove = async (id: string) => {
    setBusy(true);
    const res = await attempt(deleteBankAccountAction(id));
    setBusy(false);
    setConfirmDelete(null);
    setNotice(res.ok ? { kind: 'ok', text: 'Bank account deleted.' } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  const seed = async () => {
    setBusy(true);
    const res = await attempt(seedPaymentSetupAction());
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: `Added ${res.data.bankAccounts} bank accounts and ${res.data.methods} payment methods.` } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  const showMovements = async (a: Account) => {
    setBusy(true);
    const res = await attempt(bankLedgerAction(a.id));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setMovements(res.data);
  };

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Bank and cash accounts"
        intro="Where money sits: bank accounts, cash drawers, mobile-money settlement accounts and clearing accounts. Each one is carried by a ledger account, and every payment method pays into one of them."
        actions={
          <>
            {view.accounts.length === 0 && view.can.seed ? (
              <button type="button" className={buttonClass} disabled={busy} onClick={seed}>Add the standard accounts and methods</button>
            ) : null}
            {view.can.create ? (
              <button type="button" className={primaryClass} aria-expanded={form !== null} onClick={() => setForm(form ? null : blank(view.baseCurrency ?? 'KES'))}>
                Add account
              </button>
            ) : null}
          </>
        }
      />
      <Message notice={notice} />

      {form ? (
        <form onSubmit={save} className={`${cardClass} space-y-4`} aria-label={form.id ? `Edit ${form.code}` : 'Add a bank account'}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field id={`${uid}-code`} label="Code" hint={form.id ? 'A code does not change.' : 'Capital letters and digits, e.g. BANK-KCB.'}>
              <input id={`${uid}-code`} value={form.code} onChange={(e) => set('code', e.target.value)} className={fieldClass} required disabled={form.id !== null} maxLength={20} autoComplete="off" />
            </Field>
            <Field id={`${uid}-name`} label="Name">
              <input id={`${uid}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} required maxLength={120} />
            </Field>
            <Field id={`${uid}-kind`} label="Kind">
              <select id={`${uid}-kind`} value={form.kind} onChange={(e) => set('kind', e.target.value as Kind)} className={fieldClass}>
                {Object.entries(KINDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-cur`} label="Currency" hint="An account holds one currency.">
              <input id={`${uid}-cur`} value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} className={fieldClass} required maxLength={3} pattern="[A-Za-z]{3}" autoComplete="off" />
            </Field>
            <Field id={`${uid}-gl`} label="Ledger account" hint="The asset account that carries this money in the books.">
              <select id={`${uid}-gl`} value={form.glAccountId} onChange={(e) => set('glAccountId', e.target.value)} className={fieldClass} required>
                <option value="">Choose…</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.no} {a.name}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-fee`} label="Fees go to" hint="Where bank or mobile-money charges post (optional).">
              <select id={`${uid}-fee`} value={form.feeGlAccountId} onChange={(e) => set('feeGlAccountId', e.target.value)} className={fieldClass}>
                <option value="">None</option>
                {expenses.map((a) => <option key={a.id} value={a.id}>{a.no} {a.name}</option>)}
              </select>
            </Field>
            {form.kind === 'bank' ? (
              <>
                <Field id={`${uid}-bank`} label="Bank"><input id={`${uid}-bank`} value={form.bankName} onChange={(e) => set('bankName', e.target.value)} className={fieldClass} maxLength={80} /></Field>
                <Field id={`${uid}-acc`} label="Account number"><input id={`${uid}-acc`} value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} className={fieldClass} maxLength={40} inputMode="numeric" autoComplete="off" /></Field>
              </>
            ) : null}
            {form.kind === 'mobile_money' ? (
              <Field id={`${uid}-pb`} label="Paybill or till number"><input id={`${uid}-pb`} value={form.paybill} onChange={(e) => set('paybill', e.target.value)} className={fieldClass} maxLength={20} inputMode="numeric" autoComplete="off" /></Field>
            ) : null}
            <Field id={`${uid}-prov`} label="Filled by provider" hint="The provider account that settles into this one (optional).">
              <select id={`${uid}-prov`} value={form.providerConfigId} onChange={(e) => set('providerConfigId', e.target.value)} className={fieldClass}>
                <option value="">None (manual)</option>
                {view.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy}>{form.id ? 'Save changes' : 'Add account'}</button>
            <button type="button" className={buttonClass} onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {view.accounts.length === 0 ? (
        <p className="text-sm text-fg-muted">No bank or cash accounts yet.{view.can.seed ? ' Add the standard set above, or add your own.' : ''}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {view.accounts.map((a) => (
            <li key={a.id} className={`${cardClass} flex flex-col gap-3`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-fg-strong">{a.code} · {a.name}</p>
                  <p className="text-xs text-fg-muted">{KINDS[a.kind]} · {a.currency}</p>
                </div>
                {a.blocked ? <Chip tone="red">Blocked</Chip> : <Chip tone="green">Open</Chip>}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div><dt className="text-fg-muted">Ledger account</dt><dd className="font-semibold text-fg-strong">{a.glNo} {a.glName}</dd></div>
                <div><dt className="text-fg-muted">Balance</dt><dd className="font-semibold tabular-nums text-fg-strong">{a.currency} {money(a.balance)}</dd></div>
                <div><dt className="text-fg-muted">Used by</dt><dd className="font-semibold text-fg-strong">{a.methods} payment {a.methods === 1 ? 'method' : 'methods'}</dd></div>
                {a.details.paybill || a.details.accountNumber ? (
                  <div><dt className="text-fg-muted">{a.details.paybill ? 'Paybill / till' : 'Account no.'}</dt><dd className="font-semibold text-fg-strong">{a.details.paybill ?? a.details.accountNumber}</dd></div>
                ) : null}
              </dl>
              <div className="mt-auto flex flex-wrap gap-2">
                {view.can.ledger ? <button type="button" className={buttonClass} disabled={busy} onClick={() => showMovements(a)} aria-label={`View movements of ${a.code}`}>Movements</button> : null}
                {view.can.edit ? <button type="button" className={buttonClass} onClick={() => edit(a)} aria-label={`Edit ${a.code}`}>Edit</button> : null}
                {view.can.block ? <button type="button" className={buttonClass} disabled={busy} onClick={() => toggleBlock(a)} aria-label={`${a.blocked ? 'Unblock' : 'Block'} ${a.code}`}>{a.blocked ? 'Unblock' : 'Block'}</button> : null}
                {view.can.delete && a.methods === 0 ? (
                  confirmDelete === a.id ? (
                    <>
                      <button type="button" className={dangerClass} disabled={busy} onClick={() => remove(a.id)}>Confirm delete</button>
                      <button type="button" className={buttonClass} onClick={() => setConfirmDelete(null)}>Keep</button>
                    </>
                  ) : (
                    <button type="button" className={dangerClass} onClick={() => setConfirmDelete(a.id)} aria-label={`Delete ${a.code}`}>Delete</button>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {movements ? (
        <section className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-mov`}>
          <div className="flex items-center justify-between gap-2">
            <h3 id={`${uid}-mov`} className="text-sm font-bold text-fg-strong">Movements on {movements.account.code} — {movements.account.name}</h3>
            <button type="button" className={buttonClass} onClick={() => setMovements(null)}>Close</button>
          </div>
          {movements.entries.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing has moved through this account yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-xs">
                <caption className="sr-only">Money in and out of {movements.account.code}, newest first</caption>
                <thead className="text-fg-muted">
                  <tr><th scope="col" className="py-1 pr-3">Date</th><th scope="col" className="pr-3">Document</th><th scope="col" className="pr-3">Description</th><th scope="col" className="pr-3 text-right">Amount</th><th scope="col" className="text-right">Balance</th></tr>
                </thead>
                <tbody>
                  {movements.entries.map((m) => (
                    <tr key={m.id} className="border-t border-line">
                      <td className="py-1.5 pr-3 whitespace-nowrap">{m.postingDate}</td>
                      <td className="pr-3 whitespace-nowrap">{m.documentNo}</td>
                      <td className="pr-3">{m.description}</td>
                      <td className={`pr-3 text-right tabular-nums ${m.amount.startsWith('-') ? 'text-red-700' : 'text-emerald-700'}`}>{money(m.amount)}</td>
                      <td className="text-right tabular-nums">{money(m.running)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
