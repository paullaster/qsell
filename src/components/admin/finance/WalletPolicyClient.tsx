'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveCreditPolicyAction, type creditPolicyAction } from '@/server/domains/finance/wallet-actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof creditPolicyAction>>, { ok: true }>['data'];
type Row = View['rows'][number];

interface FormState {
  groupCode: string | null;
  walletEnabled: boolean;
  allowDeposits: boolean;
  overpaymentDefault: 'wallet' | 'hold' | 'ask';
  autoApply: 'never' | 'oldest_first';
  creditNoteExcess: 'wallet' | 'ask';
  refundsEnabled: boolean;
  walletCashOut: boolean;
  maxBalance: string;
  label: string;
}

const OVERPAY = { wallet: 'Put it in the wallet', hold: 'Leave it unapplied on the account', ask: 'Leave it unapplied until someone chooses' };

/** The newest row of each scope, which is what is in force. */
function inForce(rows: Row[]): Map<string, Row> {
  const today = new Date().toISOString().slice(0, 10);
  const m = new Map<string, Row>();
  for (const r of [...rows].filter((x) => x.effectiveFrom <= today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))) m.set(r.groupCode ?? '', r);
  return m;
}

export function WalletPolicyClient({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const current = inForce(view.rows);
  const company = current.get('');
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const edit = (groupCode: string | null) => {
    const r = current.get(groupCode ?? '') ?? company;
    setForm({
      groupCode,
      walletEnabled: r?.walletEnabled ?? false,
      allowDeposits: r?.allowDeposits ?? true,
      overpaymentDefault: r?.overpaymentDefault ?? 'ask',
      autoApply: r?.autoApply ?? 'never',
      creditNoteExcess: r?.creditNoteExcess ?? 'ask',
      refundsEnabled: r?.refundsEnabled ?? true,
      walletCashOut: r?.walletCashOut ?? false,
      maxBalance: r?.maxBalance ?? '',
      label: company?.label ?? 'Wallet',
    });
    setNotice(null);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    const res = await attempt(saveCreditPolicyAction({ ...form, maxBalance: form.maxBalance.trim() === '' ? null : form.maxBalance.trim() }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: 'Saved. It applies from today.' });
    setForm(null);
    router.refresh();
  };

  const describe = (r: Row | undefined) =>
    !r ? 'Not set: there is no wallet, and money paid beyond what is owed stays on the account.' : r.walletEnabled ? `On. Overpayments: ${OVERPAY[r.overpaymentDefault].toLowerCase()}. ${r.autoApply === 'oldest_first' ? 'Paid from automatically on credit invoices.' : 'Used only when someone chooses.'}${r.allowDeposits ? '' : ' No advance deposits.'}${r.maxBalance ? ` Holds at most ${r.maxBalance}.` : ''}` : 'Off.';

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
          {company?.walletEnabled ? <Chip tone="green">{company.label} on</Chip> : <Chip tone="gray">Off</Chip>}
        </div>
        <p className="text-sm text-fg">{describe(company)}</p>
        {view.canEdit ? <button type="button" className={buttonClass} onClick={() => edit(null)}>Change</button> : null}
      </section>

      {view.groups.map((g) => {
        const r = current.get(g.code);
        return (
          <section key={g.code} className={`${cardClass} space-y-2`} aria-label={`Customer group ${g.code}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-fg-strong"><span className="font-mono">{g.code}</span> {g.name}</h3>
              {r ? <Chip tone="sky">Its own rules</Chip> : <Chip tone="gray">Follows the whole business</Chip>}
            </div>
            {r ? <p className="text-sm text-fg">{describe(r)}</p> : null}
            {view.canEdit ? <button type="button" className={buttonClass} onClick={() => edit(g.code)} aria-label={`Change the rules for ${g.code}`}>{r ? 'Change' : 'Give it its own rules'}</button> : null}
          </section>
        );
      })}

      {form ? (
        <form onSubmit={save} className={`${cardClass} space-y-4`} aria-label={form.groupCode ? `Rules for ${form.groupCode}` : 'Rules for the whole business'}>
          <h3 className="text-sm font-bold text-fg-strong">{form.groupCode ? `Rules for ${form.groupCode}` : 'Rules for the whole business'}</h3>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.walletEnabled} onChange={(e) => set('walletEnabled', e.target.checked)} className="h-4 w-4" /> Customers can hold credit with us</label>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.allowDeposits} onChange={(e) => set('allowDeposits', e.target.checked)} className="h-4 w-4" disabled={!form.walletEnabled} /> Accept advance deposits (money paid before any invoice)</label>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.refundsEnabled} onChange={(e) => set('refundsEnabled', e.target.checked)} className="h-4 w-4" /> Money may be paid back to customers (refunds). Off means everything owed to a customer stays as credit.</label>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.walletCashOut} onChange={(e) => set('walletCashOut', e.target.checked)} className="h-4 w-4" disabled={!form.walletEnabled || !form.refundsEnabled} /> A customer may take what is in their wallet out as a refund</label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id={`${uid}-over`} label="Money paid beyond what is owed">
              <select id={`${uid}-over`} value={form.overpaymentDefault} onChange={(e) => set('overpaymentDefault', e.target.value as FormState['overpaymentDefault'])} className={fieldClass} disabled={!form.walletEnabled}>
                {Object.entries(OVERPAY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-auto`} label="On a new credit invoice">
              <select id={`${uid}-auto`} value={form.autoApply} onChange={(e) => set('autoApply', e.target.value as FormState['autoApply'])} className={fieldClass} disabled={!form.walletEnabled}>
                <option value="never">Use the wallet only when someone chooses</option>
                <option value="oldest_first">Pay from the wallet automatically</option>
              </select>
            </Field>
            <Field id={`${uid}-cn`} label="Credit note beyond what the invoice still owes">
              <select id={`${uid}-cn`} value={form.creditNoteExcess} onChange={(e) => set('creditNoteExcess', e.target.value as FormState['creditNoteExcess'])} className={fieldClass} disabled={!form.walletEnabled}>
                <option value="ask">Wait on a list until someone decides</option>
                <option value="wallet">Put it in the wallet</option>
              </select>
            </Field>
            <Field id={`${uid}-max`} label="Most a wallet may hold" hint="Leave empty for no limit.">
              <input id={`${uid}-max`} value={form.maxBalance} onChange={(e) => set('maxBalance', e.target.value)} className={fieldClass} inputMode="decimal" disabled={!form.walletEnabled} />
            </Field>
            {form.groupCode === null ? (
              <Field id={`${uid}-label`} label="What customers see it called" hint="For example Wallet, Account credit or Store credit.">
                <input id={`${uid}-label`} value={form.label} onChange={(e) => set('label', e.target.value)} className={fieldClass} maxLength={40} required />
              </Field>
            ) : null}
          </div>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Save from today</button><button type="button" className={buttonClass} onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      ) : null}
    </div>
  );
}
