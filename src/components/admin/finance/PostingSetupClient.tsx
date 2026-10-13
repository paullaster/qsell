'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addPostingGroupAction,
  saveCustomerGroupAction,
  saveGeneralSetupAction,
  type PostingSetupView,
} from '@/server/domains/finance/actions';
import { Field, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, today, type Notice, attempt } from './ui';

const GENERAL: [key: 'sales' | 'sales_returns' | 'sales_discount' | 'cogs' | 'inventory_adjustment', label: string][] = [
  ['sales', 'Sales'],
  ['sales_returns', 'Sales returns'],
  ['sales_discount', 'Sales discounts'],
  ['cogs', 'Cost of sales'],
  ['inventory_adjustment', 'Inventory adjustments'],
];
const CUSTOMER: [string, string][] = [
  ['receivables', 'Receivables'],
  ['customer_deposits', 'Customer deposits (wallet)'],
  ['refunds_payable', 'Refunds payable'],
  ['payment_discount', 'Payment discounts'],
  ['write_off', 'Write-offs'],
  ['rounding', 'Rounding'],
  ['fx_gain', 'Exchange gains'],
  ['fx_loss', 'Exchange losses'],
  ['service_charge', 'Shipping and service income'],
  ['rebate_expense', 'Rebates given (cost)'],
  ['gift_card_liability', 'Gift cards (owed to holders)'],
  ['loyalty_provision', 'Loyalty points (owed)'],
];

export function PostingSetupClient({ view }: { view: PostingSetupView }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(today());
  const [custEdit, setCustEdit] = useState<{ code: string; accounts: Record<string, string> } | null>(null);
  const [group, setGroup] = useState<{ kind: 'business' | 'product'; code: string; name: string } | null>(null);

  const acctName = (id: string | null) => {
    const a = view.accounts.find((x) => x.id === id);
    return a ? `${a.no} ${a.name}` : '— not set —';
  };
  const biz = (id: string) => view.business.find((b) => b.id === id)?.name ?? id;
  const prod = (id: string) => view.product.find((b) => b.id === id)?.name ?? id;

  // The row in force today for each pair.
  const current = view.general
    .filter((g) => g.effectiveFrom <= today() && (g.effectiveTo === null || g.effectiveTo >= today()))
    .sort((a, b) => (biz(a.businessGroupId) + prod(a.productGroupId)).localeCompare(biz(b.businessGroupId) + prod(b.productGroupId)));

  const startEdit = (id: string) => {
    const row = view.general.find((g) => g.id === id);
    if (!row) return;
    setEditing(id);
    setAccounts(Object.fromEntries(GENERAL.map(([k]) => [k, row.accounts[k] ?? ''])));
    setFrom(today());
    setNotice(null);
  };

  const saveCust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!custEdit) return;
    setBusy(true);
    const res = await attempt(saveCustomerGroupAction(custEdit.code, Object.fromEntries(CUSTOMER.map(([k]) => [k, custEdit.accounts[k] || null]))));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: `Customer group ${custEdit.code} saved.` });
    setCustEdit(null);
    router.refresh();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const row = view.general.find((g) => g.id === editing);
    if (!row) return;
    setBusy(true);
    const res = await attempt(saveGeneralSetupAction({
      businessGroupId: row.businessGroupId,
      productGroupId: row.productGroupId,
      effectiveFrom: from,
      accounts: Object.fromEntries(GENERAL.map(([k]) => [k, accounts[k] || null])),
    }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: `Saved. It applies from ${from}; earlier documents keep the setup they used.` });
    setEditing(null);
    router.refresh();
  };

  const addGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!group) return;
    setBusy(true);
    const res = await attempt(addPostingGroupAction(group.kind, group.code, group.name));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
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

      {group ? (
        <form onSubmit={addGroup} className={`${cardClass} grid grid-cols-1 gap-4 sm:grid-cols-3`} aria-label={`Add ${group.kind} posting group`}>
          <Field id={`${uid}-gc`} label="Code"><input id={`${uid}-gc`} value={group.code} onChange={(e) => setGroup({ ...group, code: e.target.value.toUpperCase() })} className={`${fieldClass} font-mono`} required autoFocus /></Field>
          <Field id={`${uid}-gn`} label="Name"><input id={`${uid}-gn`} value={group.name} onChange={(e) => setGroup({ ...group, name: e.target.value })} className={fieldClass} required /></Field>
          <div className="flex items-end gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>Add</button>
            <button type="button" className={buttonClass} onClick={() => setGroup(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      <section aria-labelledby={`${uid}-gen`} className="space-y-3">
        <h3 id={`${uid}-gen`} className="text-sm font-bold text-fg-strong">Sales and cost accounts (business group × product group)</h3>
        {editing ? (
          <form onSubmit={save} className={`${cardClass} space-y-4`} aria-label="Edit posting setup">
            {(() => {
              const row = view.general.find((g) => g.id === editing)!;
              return <p className="text-sm font-semibold text-fg-strong">{biz(row.businessGroupId)} × {prod(row.productGroupId)}</p>;
            })()}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {GENERAL.map(([k, label]) => (
                <Field key={k} id={`${uid}-${k}`} label={label}>
                  <select id={`${uid}-${k}`} value={accounts[k] ?? ''} onChange={(e) => setAccounts({ ...accounts, [k]: e.target.value })} className={fieldClass}>
                    <option value="">— not set —</option>
                    {view.accounts.map((a) => <option key={a.id} value={a.id}>{a.no} {a.name}</option>)}
                  </select>
                </Field>
              ))}
              <Field id={`${uid}-from`} label="Takes effect on"><input id={`${uid}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fieldClass} required /></Field>
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={primaryClass}>Save setup</button>
              <button type="button" className={buttonClass} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        ) : null}
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {current.map((g) => (
            <li key={g.id} className="rounded-xl border border-line bg-surface-raised p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-bold text-fg-strong">{biz(g.businessGroupId)} × {prod(g.productGroupId)}</p>
                {view.canEdit ? <button type="button" className={buttonClass} onClick={() => startEdit(g.id)} aria-label={`Edit setup for ${biz(g.businessGroupId)} × ${prod(g.productGroupId)}`}>Edit</button> : null}
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                {GENERAL.map(([k, label]) => (
                  <div key={k} className="flex justify-between gap-3"><dt className="text-fg-muted">{label}</dt><dd className="text-right text-fg">{acctName(g.accounts[k])}</dd></div>
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
                  <button type="button" className={buttonClass} onClick={() => setCustEdit({ code: c.code, accounts: Object.fromEntries(CUSTOMER.map(([k]) => [k, c.accounts[k] ?? ''])) })} aria-label={`Edit accounts of ${c.code}`}>Edit</button>
                ) : null}
              </div>
              {custEdit?.code === c.code ? (
                <form onSubmit={saveCust} className="mt-3 space-y-3" aria-label={`Accounts of ${c.code}`}>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {CUSTOMER.map(([k, label]) => (
                      <Field key={k} id={`${uid}-c-${c.code}-${k}`} label={label}>
                        <select id={`${uid}-c-${c.code}-${k}`} value={custEdit.accounts[k] ?? ''} onChange={(e) => setCustEdit({ ...custEdit, accounts: { ...custEdit.accounts, [k]: e.target.value } })} className={fieldClass}>
                          <option value="">— not set —</option>
                          {view.accounts.map((a) => <option key={a.id} value={a.id}>{a.no} {a.name}</option>)}
                        </select>
                      </Field>
                    ))}
                  </div>
                  <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Save accounts</button><button type="button" className={buttonClass} onClick={() => setCustEdit(null)}>Cancel</button></div>
                </form>
              ) : (
                <dl className="mt-2 space-y-1 text-xs">
                  {CUSTOMER.map(([k, label]) => (
                    <div key={k} className="flex justify-between gap-3"><dt className="text-fg-muted">{label}</dt><dd className="text-right text-fg">{acctName(c.accounts[k] ?? null)}</dd></div>
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
