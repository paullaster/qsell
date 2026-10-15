'use client';

import { use, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createAccountAction,
  deleteAccountAction,
  listAccountsPageAction,
  setAccountBlockedAction,
  updateAccountAction,
  type AccountView,
} from '@/server/domains/finance/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { accountInput, blankDraft, draftIsTotal, draftOf, typeWords, type AccountDraft } from '@/lib/ledger-forms';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

interface Can {
  createAccounts: boolean;
  editAccounts: boolean;
  blockAccounts: boolean;
  deleteAccounts: boolean;
}

type FirstPage = Awaited<ReturnType<typeof listAccountsPageAction>>;

export function ChartOfAccountsClient({ firstPage, can }: { firstPage: ReturnType<typeof listAccountsPageAction>; can: Can }) {
  const first = use(firstPage);
  return first.ok ? <ChartView first={first} can={can} /> : <LoadFailed error={first.error} />;
}

function ChartView({ first, can }: { first: FirstPage; can: Can }) {
  const uid = useId();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const firstField = useRef<HTMLInputElement>(null);

  const list = usePagedList<AccountView, { query: string }>({
    load: (filters, cursor) => listAccountsPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  const open = (next: AccountDraft | null) => {
    setNotice(null);
    setDraft(next);
  };
  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (draft === null) return;
    setBusy(true);
    setNotice(null);
    const input = accountInput(draft);
    const res = draft.id === null ? await attempt(createAccountAction(input)) : await attempt(updateAccountAction(draft.id, input));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: draft.id === null ? 'Account created.' : 'Account saved.' });
    setDraft(null);
    list.reload();
    router.refresh();
  };
  const toggleBlock = async (a: AccountView) => {
    setBusy(true);
    const res = await attempt(setAccountBlockedAction(a.id, !a.blocked));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: a.blocked ? `${a.no} is open for posting again.` : `${a.no} is blocked.` } : { kind: 'error', text: res.error });
    if (res.ok) list.reload();
  };
  const remove = async (a: AccountView) => {
    setBusy(true);
    const res = await attempt(deleteAccountAction(a.id));
    setBusy(false);
    setConfirming(null);
    setNotice(res.ok ? { kind: 'ok', text: `${a.no} deleted.` } : { kind: 'error', text: res.error });
    if (res.ok) list.reload();
  };

  const set = <K extends keyof AccountDraft>(k: K, v: AccountDraft[K]) => setDraft((d) => (d === null ? d : { ...d, [k]: v }));
  const posting = draft?.type.id === 'posting';

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Chart of accounts"
        intro="Every account the books can post to. Control accounts (marked) are posted only by their sub-ledger. Once an account has postings its number, type and currency are frozen."
        actions={can.createAccounts ? <button type="button" className={primaryClass} onClick={() => { open(blankDraft()); firstField.current?.focus(); }}>New account</button> : null}
      />
      <Message notice={notice} />

      {draft === null ? null : (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-4`} aria-label={draft.id === null ? 'New account' : 'Edit account'}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id={`${uid}-no`} label="Account number">
              <input ref={firstField} id={`${uid}-no`} value={draft.no} onChange={(e) => set('no', e.target.value)} className={`${fieldClass} font-mono`} disabled={draft.used} required autoFocus />
            </Field>
            <div className="sm:col-span-2">
              <Field id={`${uid}-name`} label="Name">
                <input id={`${uid}-name`} value={draft.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} required />
              </Field>
            </div>
            <ChoicePicker label="Type" source="gl-account-types" choice={draft.type} onChoice={(c) => set('type', c ?? draft.type)} clearable={false} required disabled={draft.used} />
            {posting ? <ChoicePicker label="Category" source="gl-account-categories" choice={draft.category} onChoice={(c) => set('category', c ?? draft.category)} clearable={false} required /> : null}
            <ChoicePicker label="Normal balance" source="gl-normal-balances" choice={draft.normalBalance} onChoice={(c) => set('normalBalance', c ?? draft.normalBalance)} clearable={false} required disabled={draft.used} />
            {draftIsTotal(draft) ? (
              <div className="sm:col-span-3">
                <Field id={`${uid}-tot`} label="Adds up" hint="Account numbers or ranges, like 1000..1999|2100">
                  <input id={`${uid}-tot`} value={draft.totaling} onChange={(e) => set('totaling', e.target.value)} className={`${fieldClass} font-mono`} />
                </Field>
              </div>
            ) : null}
            {posting ? (
              <>
                <Field id={`${uid}-cur`} label="Currency" hint='"any", or one code like USD'>
                  <input id={`${uid}-cur`} value={draft.currencyPolicy} onChange={(e) => set('currencyPolicy', e.target.value)} className={`${fieldClass} uppercase`} disabled={draft.used} />
                </Field>
                <ChoicePicker label="Dimensions on lines" source="gl-dimension-rules" choice={draft.dimensionRule} onChoice={(c) => set('dimensionRule', c ?? draft.dimensionRule)} clearable={false} required />
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
      )}

      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">Search accounts</label>
        <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by number or name" className={fieldClass} autoComplete="off" />
      </div>

      {list.phase === 'error' ? <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p> : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading…</p> : null}

      {/* Phone: cards. md and up: a table. */}
      <ul className="space-y-2 md:hidden" aria-label="Accounts">
        {list.rows.map((a) => (
          <li key={a.id} className="rounded-xl border border-line bg-surface-raised p-3" style={{ marginLeft: `${String(Math.min(a.indent, 4) * 8)}px` }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={`text-sm ${a.type === 'posting' ? 'text-fg-strong' : 'font-bold text-fg-strong'}`}><span className="font-mono">{a.no}</span> {a.name}</p>
              <Badges a={a} />
            </div>
            {a.totaling === null || a.totaling === '' ? null : <p className="mt-1 text-xs text-fg-muted">Adds up {a.totaling}</p>}
            <Actions a={a} can={can} busy={busy} confirming={confirming === a.id} onEdit={() => open(draftOf(a))} onBlock={() => void toggleBlock(a)} onAskDelete={() => setConfirming(a.id)} onDelete={() => void remove(a)} onKeep={() => setConfirming(null)} />
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
            {list.rows.map((a) => (
              <tr key={a.id} className="hover:bg-hover">
                <td className="px-3 py-2 font-mono text-xs text-fg-strong">{a.no}</td>
                <td className={`px-3 py-2 ${a.type === 'posting' ? 'text-fg' : 'font-bold text-fg-strong'}`} style={{ paddingLeft: `${String(12 + Math.min(a.indent, 4) * 16)}px` }}>
                  {a.name}
                  {a.totaling === null || a.totaling === '' ? null : <span className="ml-2 text-xs font-normal text-fg-muted">{a.totaling}</span>}
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted">{typeWords(a)}</td>
                <td className="px-3 py-2"><Badges a={a} /></td>
                <td className="px-3 py-2">
                  <Actions a={a} can={can} busy={busy} confirming={confirming === a.id} onEdit={() => open(draftOf(a))} onBlock={() => void toggleBlock(a)} onAskDelete={() => setConfirming(a.id)} onDelete={() => void remove(a)} onKeep={() => setConfirming(null)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted">No accounts match “{query}”.</p> : null}
      {list.cursor === null ? null : <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>{list.phase === 'more' ? 'Loading…' : 'Show more accounts'}</button>}
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

interface ActionsProps {
  a: AccountView;
  can: Can;
  busy: boolean;
  confirming: boolean;
  onEdit: () => void;
  onBlock: () => void;
  onAskDelete: () => void;
  onDelete: () => void;
  onKeep: () => void;
}

function Actions({ a, can, busy, confirming, onEdit, onBlock, onAskDelete, onDelete, onKeep }: ActionsProps) {
  const mayDelete = can.deleteAccounts && !a.used;
  return (
    <div className="mt-2 flex flex-wrap justify-end gap-2 md:mt-0">
      {can.editAccounts ? <button type="button" className={buttonClass} onClick={onEdit} disabled={busy} aria-label={`Edit account ${a.no}`}>Edit</button> : null}
      {can.blockAccounts && a.type === 'posting' ? (
        <button type="button" className={buttonClass} onClick={onBlock} disabled={busy} aria-label={`${a.blocked ? 'Unblock' : 'Block'} account ${a.no}`}>{a.blocked ? 'Unblock' : 'Block'}</button>
      ) : null}
      {mayDelete && !confirming ? <button type="button" className={dangerClass} onClick={onAskDelete} disabled={busy} aria-label={`Delete account ${a.no}`}>Delete</button> : null}
      {mayDelete && confirming ? (
        <>
          <button type="button" className={dangerClass} onClick={onDelete} disabled={busy} aria-label={`Confirm deleting account ${a.no}`}>Delete for good</button>
          <button type="button" className={buttonClass} onClick={onKeep}>Keep it</button>
        </>
      ) : null}
    </div>
  );
}
