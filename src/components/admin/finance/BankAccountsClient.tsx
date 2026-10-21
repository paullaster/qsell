'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  bankLedgerAction,
  blockBankAccountAction,
  createBankAccountAction,
  deleteBankAccountAction,
  updateBankAccountAction,
  type listBankAccountsAction,
} from '@/server/domains/finance/receivables/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { accountInput, accountNumberLine, blankAccountForm, editAccountForm, kindLabel, type AccountForm, type BankKind } from '@/lib/bank-account-form';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof listBankAccountsAction>>, { ok: true }>['data'];
type Account = View['accounts'][number];
export function BankAccountsClient({ viewPromise }: { viewPromise: ReturnType<typeof listBankAccountsAction> }) {
  const res = use(viewPromise);
  return res.ok ? <BankAccountsView view={res.data} /> : <LoadFailed error={res.error} />;
}

function BankAccountsView({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState<AccountForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [movements, setMovements] = useState<{ account: { code: string; name: string; currency: string }; entries: { id: string; postingDate: string; documentType: string; documentNo: string; description: string | null; amount: string; running: string }[] } | null>(null);

  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => setForm((f) => (f === null ? f : { ...f, [k]: v }));

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (form === null) return;
    setBusy(true);
    setNotice(null);
    const common = accountInput(form);
    const res = form.id === null
      ? await attempt(createBankAccountAction({ code: form.code.trim().toUpperCase(), ...common }))
      : await attempt(updateBankAccountAction(form.id, common));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: form.id === null ? 'Bank account added.' : 'Bank account saved.' });
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

  const showMovements = async (a: Account) => {
    setBusy(true);
    const res = await attempt(bankLedgerAction(a.id));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setMovements(res.data);
  };

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Bank and cash accounts"
        intro="The real accounts money sits in: bank accounts, cash drawers, mobile-money accounts and clearing accounts. Statements are reconciled per account. Which branch and which G/L account a payment posts to is set on each payment method (Settings → Payments)."
        actions={
          view.can.create ? (
              <button type="button" className={primaryClass} aria-expanded={form !== null} onClick={() => setForm(form === null ? blankAccountForm(view.baseCurrency ?? 'KES') : null)}>
                Add account
              </button>
            ) : null
        }
      />
      <Message notice={notice} />

      {form === null ? null : (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-4`} aria-label={form.id === null ? 'Add a bank account' : `Edit ${form.code}`}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field id={`${uid}-code`} label="Code" hint={form.id === null ? 'Capital letters and digits, e.g. BANK-KCB.' : 'A code does not change.'}>
              <input id={`${uid}-code`} value={form.code} onChange={(e) => set('code', e.target.value)} className={fieldClass} required disabled={form.id !== null} maxLength={20} autoComplete="off" />
            </Field>
            <Field id={`${uid}-name`} label="Name">
              <input id={`${uid}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} required maxLength={120} />
            </Field>
            <ChoicePicker label="Kind" source="bank-account-kinds" choice={{ id: form.kind, label: kindLabel(form.kind) }} onChoice={(c: Choice | null) => set('kind', (c?.id ?? form.kind) as BankKind)} clearable={false} required />
            <Field id={`${uid}-cur`} label="Currency" hint="An account holds one currency.">
              <input id={`${uid}-cur`} value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} className={fieldClass} required maxLength={3} pattern="[A-Za-z]{3}" autoComplete="off" />
            </Field>
            <ChoicePicker label="Fees go to" source="expense-gl-accounts" choice={form.fee} onChoice={(c) => set('fee', c)} placeholder="None" />
            {form.kind === 'bank' ? (
              <>
                <Field id={`${uid}-bank`} label="Bank"><input id={`${uid}-bank`} value={form.bankName} onChange={(e) => set('bankName', e.target.value)} className={fieldClass} maxLength={80} /></Field>
                <ChoicePicker label="Read its statement through" source="statement-providers" choice={form.provider} onChoice={(c) => set('provider', c)} placeholder="Not connected" />
                <Field id={`${uid}-acc`} label="Account number"><input id={`${uid}-acc`} value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} className={fieldClass} maxLength={40} inputMode="numeric" autoComplete="off" /></Field>
              </>
            ) : null}
            {form.kind === 'mobile_money' ? (
              <Field id={`${uid}-pb`} label="Paybill or till number"><input id={`${uid}-pb`} value={form.paybill} onChange={(e) => set('paybill', e.target.value)} className={fieldClass} maxLength={20} inputMode="numeric" autoComplete="off" /></Field>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy}>{form.id === null ? 'Add account' : 'Save changes'}</button>
            <button type="button" className={buttonClass} onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      {view.accounts.length === 0 ? <p className="text-sm text-fg-muted">No bank or cash accounts yet. Add one, or add the standard set under Settings → Payments.</p> : null}
      {view.accounts.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {view.accounts.map((a) => (
            <li key={a.id} className={`${cardClass} flex flex-col gap-3`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-fg-strong">{a.code} · {a.name}</p>
                  <p className="text-xs text-fg-muted">{kindLabel(a.kind)} · {a.currency}</p>
                </div>
                {a.blocked ? <Chip tone="red">Blocked</Chip> : <Chip tone="green">Open</Chip>}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div><dt className="text-fg-muted">Posts to</dt><dd className="font-semibold text-fg-strong">{a.glNos.length > 0 ? a.glNos.join(', ') : 'Nothing yet'}</dd></div>
                <div><dt className="text-fg-muted">Balance</dt><dd className="font-semibold tabular-nums text-fg-strong">{a.currency} {money(a.balance)}</dd></div>
                <div><dt className="text-fg-muted">Used by</dt><dd className="font-semibold text-fg-strong">{a.methods} payment {a.methods === 1 ? 'method' : 'methods'}</dd></div>
                {accountNumberLine(a.details) === null ? null : (
                  <div><dt className="text-fg-muted">{accountNumberLine(a.details)?.label}</dt><dd className="font-semibold text-fg-strong">{accountNumberLine(a.details)?.value}</dd></div>
                )}
              </dl>
              <div className="mt-auto flex flex-wrap gap-2">
                {view.can.ledger ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void showMovements(a)} aria-label={`View movements of ${a.code}`}>Movements</button> : null}
                {view.can.edit ? <button type="button" className={buttonClass} onClick={() => setForm(editAccountForm(a))} aria-label={`Edit ${a.code}`}>Edit</button> : null}
                {view.can.block ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void toggleBlock(a)} aria-label={`${a.blocked ? 'Unblock' : 'Block'} ${a.code}`}>{a.blocked ? 'Unblock' : 'Block'}</button> : null}
                {view.can.delete && a.methods === 0 && confirmDelete === a.id ? (
                  <>
                    <button type="button" className={dangerClass} disabled={busy} onClick={() => void remove(a.id)}>Confirm delete</button>
                    <button type="button" className={buttonClass} onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : null}
                {view.can.delete && a.methods === 0 && confirmDelete !== a.id ? <button type="button" className={dangerClass} onClick={() => setConfirmDelete(a.id)} aria-label={`Delete ${a.code}`}>Delete</button> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {movements !== null ? (
        <section className={`${cardClass} space-y-3`} aria-labelledby={`${uid}-mov`}>
          <div className="flex items-center justify-between gap-2">
            <h3 id={`${uid}-mov`} className="text-sm font-bold text-fg-strong">Movements on {movements.account.code} — {movements.account.name}</h3>
            <button type="button" className={buttonClass} onClick={() => setMovements(null)}>Close</button>
          </div>
          {movements.entries.length === 0 ? <p className="text-sm text-fg-muted">Nothing has moved through this account yet.</p> : null}
          {movements.entries.length > 0 ? (
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
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
