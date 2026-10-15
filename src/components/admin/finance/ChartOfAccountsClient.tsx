'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createAccountAction,
  deleteAccountAction,
  setAccountBlockedAction,
  updateAccountAction,
  type AccountView,
} from '@/server/domains/finance/actions';
import {
  Chip,
  Field,
  Message,
  PageHeader,
  buttonClass,
  cardClass,
  dangerClass,
  fieldClass,
  primaryClass,
  type Notice, attempt } from './ui';

import { has } from '@/lib/has';

interface Can {
  createAccounts: boolean;
  editAccounts: boolean;
  blockAccounts: boolean;
  deleteAccounts: boolean;
}

const TYPES = [
  ['posting', 'Posting (holds a balance)'],
  ['heading', 'Heading'],
  ['begin_total', 'Begin-total'],
  ['end_total', 'End-total (adds up a range)'],
  ['total', 'Total (adds up a range)'],
] as const;
const CATEGORIES = [
  ['assets', 'Assets'],
  ['liabilities', 'Liabilities'],
  ['equity', 'Equity'],
  ['income', 'Income'],
  ['cost_of_sales', 'Cost of sales'],
  ['expense', 'Expense'],
] as const;

interface Draft {
  id: string | null;
  no: string;
  name: string;
  type: AccountView['type'];
  category: NonNullable<AccountView['category']>;
  normalBalance: 'debit' | 'credit';
  directPosting: boolean;
  control: boolean;
  currencyPolicy: string;
  dimensionRule: 'none' | 'required' | 'forbidden';
  totaling: string;
  indent: number;
  used: boolean;
}

const blank: Draft = {
  id: null,
  no: '',
  name: '',
  type: 'posting',
  category: 'assets',
  normalBalance: 'debit',
  directPosting: true,
  control: false,
  currencyPolicy: 'any',
  dimensionRule: 'none',
  totaling: '',
  indent: 0,
  used: false,
};

const toDraft = (a: AccountView): Draft => ({
  id: a.id,
  no: a.no,
  name: a.name,
  type: a.type,
  category: a.category ?? 'assets',
  normalBalance: a.normalBalance,
  directPosting: a.directPosting,
  control: a.postingSource === 'engine_only',
  currencyPolicy: a.currencyPolicy,
  dimensionRule: a.dimensionRule,
  totaling: a.totaling ?? '',
  indent: a.indent,
  used: a.used,
});

export function ChartOfAccountsClient({ accounts, can }: { accounts: AccountView[]; can: Can }) {
  const uid = useId();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft) firstField.current?.focus();
  }, [draft?.id, draft === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? accounts : accounts.filter((a) => a.no.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
  }, [accounts, query]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    const input = {
      no: draft.no,
      name: draft.name,
      type: draft.type,
      category: draft.type === 'posting' ? draft.category : null,
      normalBalance: draft.normalBalance,
      directPosting: draft.type === 'posting' && draft.directPosting,
      postingSource: draft.control ? ('engine_only' as const) : ('manual' as const),
      currencyPolicy: draft.currencyPolicy.trim() === '' ? 'any' : draft.currencyPolicy.trim().toUpperCase(),
      dimensionRule: draft.dimensionRule,
      totaling: draft.totaling.trim() === '' ? null : draft.totaling.trim(),
      indent: draft.indent,
    };
    const res = has(draft.id) ? await attempt(updateAccountAction(draft.id, input)) : await attempt(createAccountAction(input));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: has(draft.id) ? 'Account saved.' : 'Account created.' });
    setDraft(null);
    router.refresh();
  };

  const toggleBlock = async (a: AccountView) => {
    setBusy(true);
    const res = await attempt(setAccountBlockedAction(a.id, !a.blocked));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: a.blocked ? `${a.no} is open for posting again.` : `${a.no} is blocked.` } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  const remove = async (a: AccountView) => {
    if (!window.confirm(`Delete account ${a.no} ${a.name}? This cannot be undone.`)) return;
    setBusy(true);
    const res = await attempt(deleteAccountAction(a.id));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: `${a.no} deleted.` } : { kind: 'error', text: res.error });
    if (res.ok) router.refresh();
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const isTotal = draft?.type === 'total' || draft?.type === 'end_total';

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Chart of accounts"
        intro="Every account the books can post to. Control accounts (marked) are posted only by their sub-ledger. Once an account has postings its number, type and currency are frozen."
        actions={
          can.createAccounts ? (
            <button type="button" className={primaryClass} onClick={() => { setNotice(null); setDraft({ ...blank }); }}>
              New account
            </button>
          ) : null
        }
      />
      <Message notice={notice} />

      {draft ? (
        <form onSubmit={save} className={`${cardClass} space-y-4`} aria-label={has(draft.id) ? 'Edit account' : 'New account'}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id={`${uid}-no`} label="Account number">
              <input ref={firstField} id={`${uid}-no`} value={draft.no} onChange={(e) => set('no', e.target.value)} className={`${fieldClass} font-mono`} disabled={draft.used} required />
            </Field>
            <div className="sm:col-span-2">
              <Field id={`${uid}-name`} label="Name">
                <input id={`${uid}-name`} value={draft.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} required />
              </Field>
            </div>
            <Field id={`${uid}-type`} label="Type">
              <select id={`${uid}-type`} value={draft.type} onChange={(e) => set('type', e.target.value as Draft['type'])} className={fieldClass} disabled={draft.used}>
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            {draft.type === 'posting' ? (
              <Field id={`${uid}-cat`} label="Category">
                <select id={`${uid}-cat`} value={draft.category} onChange={(e) => set('category', e.target.value as Draft['category'])} className={fieldClass}>
                  {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
            ) : null}
            <Field id={`${uid}-nb`} label="Normal balance">
              <select id={`${uid}-nb`} value={draft.normalBalance} onChange={(e) => set('normalBalance', e.target.value as 'debit' | 'credit')} className={fieldClass} disabled={draft.used}>
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </Field>
            {isTotal ? (
              <div className="sm:col-span-3">
                <Field id={`${uid}-tot`} label="Adds up" hint="Account numbers or ranges, like 1000..1999|2100">
                  <input id={`${uid}-tot`} value={draft.totaling} onChange={(e) => set('totaling', e.target.value)} className={`${fieldClass} font-mono`} />
                </Field>
              </div>
            ) : null}
            {draft.type === 'posting' ? (
              <>
                <Field id={`${uid}-cur`} label="Currency" hint='"any", or one code like USD'>
                  <input id={`${uid}-cur`} value={draft.currencyPolicy} onChange={(e) => set('currencyPolicy', e.target.value)} className={`${fieldClass} uppercase`} disabled={draft.used} />
                </Field>
                <Field id={`${uid}-dim`} label="Dimensions on lines">
                  <select id={`${uid}-dim`} value={draft.dimensionRule} onChange={(e) => set('dimensionRule', e.target.value as Draft['dimensionRule'])} className={fieldClass}>
                    <option value="none">Optional</option>
                    <option value="required">Required</option>
                    <option value="forbidden">Not allowed</option>
                  </select>
                </Field>
                <div className="flex flex-col justify-end gap-2 pb-1">
                  <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
                    <input type="checkbox" checked={draft.directPosting} onChange={(e) => set('directPosting', e.target.checked)} /> Allow direct posting
                  </label>
                  <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
                    <input type="checkbox" checked={draft.control} onChange={(e) => set('control', e.target.checked)} /> Control account (sub-ledger only)
                  </label>
                </div>
              </>
            ) : null}
          </div>
          {draft.used ? <p className="text-xs text-fg-muted">This account has postings: number, type, normal balance and currency are locked.</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>{busy ? 'Saving…' : 'Save account'}</button>
            <button type="button" className={buttonClass} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">Search accounts</label>
        <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by number or name" className={fieldClass} />
      </div>

      {/* Phone: cards. md and up: a table. */}
      <ul className="space-y-2 md:hidden" aria-label="Accounts">
        {shown.map((a) => (
          <li key={a.id} className="rounded-xl border border-line bg-surface-raised p-3" style={{ marginLeft: `${Math.min(a.indent, 4) * 8}px` }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={`text-sm ${a.type === 'posting' ? 'text-fg-strong' : 'font-bold text-fg-strong'}`}>
                <span className="font-mono">{a.no}</span> {a.name}
              </p>
              <Badges a={a} />
            </div>
            {has(a.totaling) ? <p className="mt-1 text-xs text-fg-muted">Adds up {a.totaling}</p> : null}
            <Actions a={a} can={can} busy={busy} onEdit={() => { setNotice(null); setDraft(toDraft(a)); }} onBlock={() => toggleBlock(a)} onDelete={() => remove(a)} />
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Chart of accounts</caption>
          <thead className="bg-surface-sunken text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold">Number</th>
              <th scope="col" className="px-3 py-2 font-semibold">Name</th>
              <th scope="col" className="px-3 py-2 font-semibold">Type</th>
              <th scope="col" className="px-3 py-2 font-semibold">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((a) => (
              <tr key={a.id} className="hover:bg-hover">
                <td className="px-3 py-2 font-mono text-xs text-fg-strong">{a.no}</td>
                <td className={`px-3 py-2 ${a.type === 'posting' ? 'text-fg' : 'font-bold text-fg-strong'}`} style={{ paddingLeft: `${12 + Math.min(a.indent, 4) * 16}px` }}>
                  {a.name}
                  {has(a.totaling) ? <span className="ml-2 text-xs font-normal text-fg-muted">{a.totaling}</span> : null}
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted">{a.type === 'posting' ? (a.category ?? '').replace('_', ' ') : a.type.replace('_', '-')}</td>
                <td className="px-3 py-2"><Badges a={a} /></td>
                <td className="px-3 py-2">
                  <Actions a={a} can={can} busy={busy} onEdit={() => { setNotice(null); setDraft(toDraft(a)); }} onBlock={() => toggleBlock(a)} onDelete={() => remove(a)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 ? <p className="text-sm text-fg-muted">No accounts match “{query}”.</p> : null}
    </div>
  );
}

function Badges({ a }: { a: AccountView }) {
  return (
    <span className="flex flex-wrap gap-1">
      {a.postingSource === 'engine_only' ? <Chip tone="sky">Control</Chip> : null}
      {a.blocked ? <Chip tone="red">Blocked</Chip> : null}
      {a.used ? <Chip tone="gray">Has postings</Chip> : null}
      {a.type === 'posting' && !a.directPosting ? <Chip tone="amber">No direct posting</Chip> : null}
    </span>
  );
}

function Actions({ a, can, busy, onEdit, onBlock, onDelete }: { a: AccountView; can: Can; busy: boolean; onEdit: () => void; onBlock: () => void; onDelete: () => void }) {
  return (
    <div className="mt-2 flex flex-wrap justify-end gap-2 md:mt-0">
      {can.editAccounts ? <button type="button" className={buttonClass} onClick={onEdit} disabled={busy} aria-label={`Edit account ${a.no}`}>Edit</button> : null}
      {can.blockAccounts && a.type === 'posting' ? (
        <button type="button" className={buttonClass} onClick={onBlock} disabled={busy} aria-label={`${a.blocked ? 'Unblock' : 'Block'} account ${a.no}`}>
          {a.blocked ? 'Unblock' : 'Block'}
        </button>
      ) : null}
      {can.deleteAccounts && !a.used ? <button type="button" className={dangerClass} onClick={onDelete} disabled={busy} aria-label={`Delete account ${a.no}`}>Delete</button> : null}
    </div>
  );
}
