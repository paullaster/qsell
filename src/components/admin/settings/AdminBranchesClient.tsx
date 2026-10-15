'use client';

import { use, useId, useState } from 'react';
import { branchesPageAction, createBranchAction, updateBranchAction, type BranchView } from '@/server/domains/branches/actions';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, buttonClass, Chip, Field, fieldClass, LoadFailed, Message, PageHeader, primaryClass, cardClass, type Notice } from '@/components/ui/screen-kit';
import { branchPayload, emptyBranchForm, type BranchForm } from '@/lib/branch-forms';

type FirstPage = Awaited<ReturnType<typeof branchesPageAction>>;

interface Props {
  firstPage: ReturnType<typeof branchesPageAction>;
  canManage: Promise<boolean>;
  /** Inside a dialog that already shows the title. */
  embedded?: boolean;
}

export function AdminBranchesClient({ firstPage, canManage, embedded = false }: Props) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <BranchesView first={first} may={may} embedded={embedded} /> : <LoadFailed error={first.error} />;
}

function BranchesView({ first, may, embedded }: { first: FirstPage; may: boolean; embedded: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<BranchForm>(emptyBranchForm);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<BranchView, { query: string }>({
    load: (filters, cursor) => branchesPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  const finish = (ok: boolean, text: string) => {
    setBusy(false);
    setNotice({ kind: ok ? 'ok' : 'error', text });
    if (ok) list.reload();
  };
  const create = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = branchPayload(form);
    if (!checked.ok) {
      setNotice({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    const res = await attempt(createBranchAction(checked.payload));
    if (res.ok) setForm(emptyBranchForm());
    finish(res.ok, res.ok ? `${checked.payload.name} added.` : res.error);
  };
  const change = async (b: BranchView, patch: { actsIndependently?: boolean; isDefault?: boolean }, done: string) => {
    setBusy(true);
    const res = await attempt(updateBranchAction(b.id, patch));
    finish(res.ok, res.ok ? done : res.error);
  };

  return (
    <div className="max-w-5xl space-y-5">
      {embedded ? (
        <p className="max-w-2xl text-sm text-fg-muted">Each branch can hold its own payment credentials, KRA PIN, and banking details when marked as independent.</p>
      ) : (
        <PageHeader title="Branches" intro="Each branch can hold its own payment credentials, KRA PIN, and banking details when marked as independent." />
      )}
      <Message notice={notice} />

      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search branches
        </label>
        <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or name" className={fieldClass} autoComplete="off" />
      </div>
      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {list.phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}

      <ul className="space-y-2" aria-label="Branches">
        {list.rows.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <p className="min-w-0 text-sm font-semibold text-fg-strong">
              <span className="font-mono font-normal text-fg">{b.code}</span> · {b.name} {b.isDefault ? <Chip tone="amber">Default</Chip> : null} {b.isActive ? null : <Chip tone="gray">Closed</Chip>}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex min-h-10 items-center gap-2 text-xs text-fg">
                <input
                  type="checkbox"
                  className="h-5 w-5 rounded border-line-strong"
                  checked={b.actsIndependently}
                  disabled={!may || busy}
                  onChange={(e) => void change(b, { actsIndependently: e.target.checked }, `${b.name} updated.`)}
                  aria-label={`${b.name} acts independently`}
                />
                Independent
              </label>
              {may && !b.isDefault ? (
                <button type="button" className={buttonClass} disabled={busy} onClick={() => void change(b, { isDefault: true }, `${b.name} is now the default.`)} aria-label={`Make ${b.name} the default`}>
                  Make default
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted">{query.trim() === '' ? 'No branches yet.' : `No branches match “${query.trim()}”.`}</p> : null}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more branches'}
        </button>
      )}

      {may ? (
        <form onSubmit={(e) => void create(e)} className={`${cardClass} space-y-3`} aria-label="Add branch">
          <h3 className="text-sm font-bold text-fg-strong">Add branch</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-code`} label="Code">
              <input id={`${uid}-code`} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. NBO" className={`${fieldClass} font-mono uppercase`} required />
            </Field>
            <Field id={`${uid}-name`} label="Name">
              <input id={`${uid}-name`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Nairobi Branch" className={fieldClass} required />
            </Field>
          </div>
          <label className="flex min-h-10 items-center gap-2 text-xs text-fg">
            <input type="checkbox" checked={form.actsIndependently} onChange={(e) => setForm({ ...form, actsIndependently: e.target.checked })} className="h-5 w-5 rounded border-line-strong" />
            Acts as independent unit (own KRA / paybill / bank)
          </label>
          <button type="submit" disabled={busy} className={primaryClass}>
            {busy ? 'Creating…' : 'Create branch'}
          </button>
        </form>
      ) : null}
    </div>
  );
}
