'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { addPostingGroupAction, type postingSetupAction, saveCustomerGroupAction, saveGeneralSetupAction } from '@/server/domains/finance/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { CUSTOMER_PURPOSES, GENERAL_PURPOSES, accountIds, accountName, inForceToday, startingAccounts } from '@/lib/ledger-forms';
import type { Choice } from '@/lib/payment-options';
import { Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, today, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof postingSetupAction>>, { ok: true }>['data'];
type Chosen = Record<string, Choice | null>;

export function PostingSetupClient({ viewPromise }: { viewPromise: ReturnType<typeof postingSetupAction> }) {
  const res = use(viewPromise);
  return res.ok ? <PostingSetupView view={res.data} /> : <LoadFailed error={res.error} />;
}

/** One account chosen for each purpose, searched on the server as the person types. */
function AccountChoices({ idPrefix, purposes, chosen, onChange }: { idPrefix: string; purposes: readonly (readonly [string, string])[]; chosen: Chosen; onChange: (next: Chosen) => void }) {
  return (
    <>
      {purposes.map(([key, label]) => (
        <ChoicePicker key={`${idPrefix}-${key}`} label={label} source="setup-gl-accounts" choice={chosen[key] ?? null} onChoice={(c) => onChange({ ...chosen, [key]: c })} placeholder="— not set —" />
      ))}
    </>
  );
}

function PostingSetupView({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Chosen>({});
  const [from, setFrom] = useState(today());
  const [custEdit, setCustEdit] = useState<{ code: string; accounts: Chosen } | null>(null);
  const [group, setGroup] = useState<{ kind: 'business' | 'product'; code: string; name: string } | null>(null);

  const biz = (id: string) => view.business.find((b) => b.id === id)?.name ?? id;
  const prod = (id: string) => view.product.find((b) => b.id === id)?.name ?? id;
  const pairName = (g: { businessGroupId: string; productGroupId: string }) => `${biz(g.businessGroupId)} × ${prod(g.productGroupId)}`;
  const current = inForceToday(view.general, today(), pairName);
  const editingRow = view.general.find((g) => g.id === editing);

  const startEdit = (id: string) => {
    const row = view.general.find((g) => g.id === id);
    if (row === undefined) return;
    setEditing(id);
    setAccounts(startingAccounts(GENERAL_PURPOSES, row.accounts, view.accountLabels));
    setFrom(today());
    setNotice(null);
  };

  const saveCust = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (custEdit === null) return;
    setBusy(true);
    const res = await attempt(saveCustomerGroupAction(custEdit.code, accountIds(custEdit.accounts)));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: `Customer group ${custEdit.code} saved.` });
    setCustEdit(null);
    router.refresh();
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (editingRow === undefined) return;
    setBusy(true);
    const res = await attempt(saveGeneralSetupAction({ businessGroupId: editingRow.businessGroupId, productGroupId: editingRow.productGroupId, effectiveFrom: from, accounts: accountIds(accounts) }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: `Saved. It applies from ${from}; earlier documents keep the setup they used.` });
    setEditing(null);
    router.refresh();
  };

  const addGroup = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (group === null) return;
    setBusy(true);
    const res = await attempt(addPostingGroupAction(group.kind, group.code, group.name));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'Group added. Give each business × product pair its accounts below.' });
    setGroup(null);
    router.refresh();
  };

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Posting setup"
        intro="Decides which account each kind of posting goes to. Changes take effect from a date you choose; documents already posted keep the setup they were posted with."
        actions={
          view.canEdit ? (
            <>
              <button type="button" className={buttonClass} onClick={() => setGroup({ kind: 'business', code: '', name: '' })}>Add business group</button>
              <button type="button" className={buttonClass} onClick={() => setGroup({ kind: 'product', code: '', name: '' })}>Add product group</button>
            </>
          ) : null
        }
      />
      <Message notice={notice} />

      {group === null ? null : (
        <form onSubmit={(e) => void addGroup(e)} className={`${cardClass} grid grid-cols-1 gap-4 sm:grid-cols-3`} aria-label={`Add ${group.kind} posting group`}>
          <Field id={`${uid}-gc`} label="Code"><input id={`${uid}-gc`} value={group.code} onChange={(e) => setGroup({ ...group, code: e.target.value.toUpperCase() })} className={`${fieldClass} font-mono`} required autoFocus autoComplete="off" /></Field>
          <Field id={`${uid}-gn`} label="Name"><input id={`${uid}-gn`} value={group.name} onChange={(e) => setGroup({ ...group, name: e.target.value })} className={fieldClass} required autoComplete="off" /></Field>
          <div className="flex items-end gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>Add</button>
            <button type="button" className={buttonClass} onClick={() => setGroup(null)}>Cancel</button>
          </div>
        </form>
      )}

      <section aria-labelledby={`${uid}-gen`} className="space-y-3">
        <h3 id={`${uid}-gen`} className="text-sm font-bold text-fg-strong">Sales and cost accounts (business group × product group)</h3>
        {editingRow === undefined ? null : (
          <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-4`} aria-label="Edit posting setup">
            <p className="text-sm font-semibold text-fg-strong">{pairName(editingRow)}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <AccountChoices idPrefix="general" purposes={GENERAL_PURPOSES} chosen={accounts} onChange={setAccounts} />
              <Field id={`${uid}-from`} label="Takes effect on"><input id={`${uid}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fieldClass} required /></Field>
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={primaryClass}>Save setup</button>
              <button type="button" className={buttonClass} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        )}
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {current.map((g) => (
            <li key={g.id} className="rounded-xl border border-line bg-surface-raised p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-bold text-fg-strong">{pairName(g)}</p>
                {view.canEdit ? <button type="button" className={buttonClass} onClick={() => startEdit(g.id)} aria-label={`Edit setup for ${pairName(g)}`}>Edit</button> : null}
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                {GENERAL_PURPOSES.map(([k, label]) => (
                  <div key={k} className="flex justify-between gap-3"><dt className="text-fg-muted">{label}</dt><dd className="text-right text-fg">{accountName(view.accountLabels, g.accounts[k as keyof typeof g.accounts])}</dd></div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        {current.length === 0 ? <p className="text-sm text-fg-muted">No setup in force today.</p> : null}
      </section>

      <section aria-labelledby={`${uid}-cust`} className="space-y-3">
        <h3 id={`${uid}-cust`} className="text-sm font-bold text-fg-strong">Customer posting groups</h3>
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {view.customer.map((c) => (
            <li key={c.id} className="rounded-xl border border-line bg-surface-raised p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-bold text-fg-strong"><span className="font-mono">{c.code}</span> {c.name}</p>
                {view.canEdit && custEdit?.code !== c.code ? (
                  <button type="button" className={buttonClass} onClick={() => setCustEdit({ code: c.code, accounts: startingAccounts(CUSTOMER_PURPOSES, c.accounts, view.accountLabels) })} aria-label={`Edit accounts of ${c.code}`}>Edit</button>
                ) : null}
              </div>
              {custEdit?.code === c.code ? (
                <form onSubmit={(e) => void saveCust(e)} className="mt-3 space-y-3" aria-label={`Accounts of ${c.code}`}>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <AccountChoices idPrefix={`c-${c.code}`} purposes={CUSTOMER_PURPOSES} chosen={custEdit.accounts} onChange={(next) => setCustEdit({ ...custEdit, accounts: next })} />
                  </div>
                  <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Save accounts</button><button type="button" className={buttonClass} onClick={() => setCustEdit(null)}>Cancel</button></div>
                </form>
              ) : (
                <dl className="mt-2 space-y-1 text-xs">
                  {CUSTOMER_PURPOSES.map(([k, label]) => (
                    <div key={k} className="flex justify-between gap-3"><dt className="text-fg-muted">{label}</dt><dd className="text-right text-fg">{accountName(view.accountLabels, Object.hasOwn(c.accounts, k) ? c.accounts[k] : null)}</dd></div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
        <p className="text-xs text-fg-muted">Customer group accounts are used by receipts, credit invoices, cash sales, rebates, and later the customer wallet and refunds.</p>
      </section>
    </div>
  );
}
