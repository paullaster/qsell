'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveCreditPolicyAction, type creditPolicyAction } from '@/server/domains/finance/wallet-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { AUTO_APPLY_MODES, CREDIT_NOTE_MODES, OVERPAYMENT_MODES, choiceOf, describePolicy, inForce, policyInput, startingForm, type PolicyForm } from '@/lib/wallet-policy';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof creditPolicyAction>>, { ok: true }>['data'];

export function WalletPolicyClient({ viewPromise }: { viewPromise: ReturnType<typeof creditPolicyAction> }) {
  const res = use(viewPromise);
  return res.ok ? <WalletPolicyView view={res.data} /> : <LoadFailed error={res.error} />;
}

function WalletPolicyView({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const current = inForce(view.rows, view.today);
  const company = current.get('');
  const set = <K extends keyof PolicyForm>(k: K, v: PolicyForm[K]) => setForm((f) => (f === null ? f : { ...f, [k]: v }));
  const pick = (k: 'overpaymentDefault' | 'autoApply' | 'creditNoteExcess') => (c: Choice | null) => set(k, c?.id ?? '');

  const edit = (groupCode: string | null) => {
    setForm(startingForm(groupCode, current.get(groupCode ?? ''), company));
    setNotice(null);
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (form === null) return;
    setBusy(true);
    const res = await attempt(saveCreditPolicyAction(policyInput(form)));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'Saved. It applies from today.' });
    setForm(null);
    router.refresh();
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Wallet policy"
        intro="Whether customers can hold credit with you, and what happens to money paid beyond what is owed. It applies to the whole business, and a customer posting group can have its own rules. A change applies from today; what was recorded before is not touched."
      />
      <Message notice={notice} />

      <section className={`${cardClass} space-y-2`} aria-labelledby={`${uid}-co`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${uid}-co`} className="text-sm font-bold text-fg-strong">Whole business</h3>
          {company?.walletEnabled === true ? <Chip tone="green">{company.label} on</Chip> : <Chip tone="gray">Off</Chip>}
        </div>
        <p className="text-sm text-fg">{describePolicy(company)}</p>
        {view.canEdit ? <button type="button" className={buttonClass} onClick={() => edit(null)}>Change</button> : null}
      </section>

      {view.groups.map((g) => {
        const r = current.get(g.code);
        return (
          <section key={g.code} className={`${cardClass} space-y-2`} aria-label={`Customer group ${g.code}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-fg-strong"><span className="font-mono">{g.code}</span> {g.name}</h3>
              {r === undefined ? <Chip tone="gray">Follows the whole business</Chip> : <Chip tone="sky">Its own rules</Chip>}
            </div>
            {r === undefined ? null : <p className="text-sm text-fg">{describePolicy(r)}</p>}
            {view.canEdit ? <button type="button" className={buttonClass} onClick={() => edit(g.code)} aria-label={`Change the rules for ${g.code}`}>{r === undefined ? 'Give it its own rules' : 'Change'}</button> : null}
          </section>
        );
      })}

      {form === null ? null : (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-4`} aria-label={form.groupCode === null ? 'Rules for the whole business' : `Rules for ${form.groupCode}`}>
          <h3 className="text-sm font-bold text-fg-strong">{form.groupCode === null ? 'Rules for the whole business' : `Rules for ${form.groupCode}`}</h3>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.walletEnabled} onChange={(e) => set('walletEnabled', e.target.checked)} className="h-4 w-4" /> Customers can hold credit with us</label>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.allowDeposits} onChange={(e) => set('allowDeposits', e.target.checked)} className="h-4 w-4" disabled={!form.walletEnabled} /> Accept advance deposits (money paid before any invoice)</label>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.refundsEnabled} onChange={(e) => set('refundsEnabled', e.target.checked)} className="h-4 w-4" /> Money may be paid back to customers (refunds). Off means everything owed to a customer stays as credit.</label>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.walletCashOut} onChange={(e) => set('walletCashOut', e.target.checked)} className="h-4 w-4" disabled={!form.walletEnabled || !form.refundsEnabled} /> A customer may take what is in their wallet out as a refund</label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ChoicePicker label="Money paid beyond what is owed" source="wallet-overpayment-modes" choice={choiceOf(OVERPAYMENT_MODES, form.overpaymentDefault)} onChoice={pick('overpaymentDefault')} clearable={false} required disabled={!form.walletEnabled} />
            <ChoicePicker label="On a new credit invoice" source="wallet-auto-apply-modes" choice={choiceOf(AUTO_APPLY_MODES, form.autoApply)} onChoice={pick('autoApply')} clearable={false} required disabled={!form.walletEnabled} />
            <ChoicePicker label="Credit note beyond what the invoice still owes" source="wallet-credit-note-modes" choice={choiceOf(CREDIT_NOTE_MODES, form.creditNoteExcess)} onChoice={pick('creditNoteExcess')} clearable={false} required disabled={!form.walletEnabled} />
            <Field id={`${uid}-max`} label="Most a wallet may hold" hint="Leave empty for no limit.">
              <input id={`${uid}-max`} value={form.maxBalance} onChange={(e) => set('maxBalance', e.target.value)} className={fieldClass} inputMode="decimal" disabled={!form.walletEnabled} />
            </Field>
            <Field id={`${uid}-exp`} label="Credit lapses after (days unused)" hint="Leave empty for credit that never lapses. A balance nobody has touched for this long becomes income.">
              <input id={`${uid}-exp`} value={form.expiryDays} onChange={(e) => set('expiryDays', e.target.value)} className={fieldClass} inputMode="numeric" disabled={!form.walletEnabled} />
            </Field>
            <Field id={`${uid}-notice`} label="Warn this many days before" hint="Balances about to lapse are listed on the wallets page.">
              <input id={`${uid}-notice`} value={form.expiryNoticeDays} onChange={(e) => set('expiryNoticeDays', e.target.value)} className={fieldClass} inputMode="numeric" disabled={!form.walletEnabled || form.expiryDays.trim() === ''} />
            </Field>
            {form.groupCode === null ? (
              <Field id={`${uid}-label`} label="What customers see it called" hint="For example Wallet, Account credit or Store credit.">
                <input id={`${uid}-label`} value={form.label} onChange={(e) => set('label', e.target.value)} className={fieldClass} maxLength={40} required />
              </Field>
            ) : null}
          </div>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Save from today</button><button type="button" className={buttonClass} onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}
