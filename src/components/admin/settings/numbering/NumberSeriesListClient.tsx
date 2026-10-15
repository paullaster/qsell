'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createNumberSeriesAction, numberSeriesPageAction, seedStandardNumberSeriesAction, type SeriesSummary } from '@/server/kernel/numbering/actions';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, buttonClass, cardClass, Chip, Field, fieldClass, LoadFailed, Message, PageHeader, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { boundWords, MODE_CHOICES, type SeriesMode } from '@/lib/number-series-forms';

type FirstPage = Awaited<ReturnType<typeof numberSeriesPageAction>>;

export function ModeChip({ mode }: { mode: SeriesMode }) {
  return mode === 'gap_free' ? <Chip tone="green">Gap-free</Chip> : <Chip tone="sky">Allows gaps · fast</Chip>;
}

export function NumberSeriesListClient({ firstPage, canManage }: { firstPage: ReturnType<typeof numberSeriesPageAction>; canManage: Promise<boolean> }) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <SeriesList first={first} may={may} /> : <LoadFailed error={first.error} />;
}

function SeriesList({ first, may }: { first: FirstPage; may: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [form, setForm] = useState<{ code: string; description: string; mode: SeriesMode }>({ code: '', description: '', mode: 'gap_free' });

  const list = usePagedList<SeriesSummary, { query: string }>({
    load: (filters, cursor) => numberSeriesPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  const create = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(createNumberSeriesAction({ ...form }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.push(`/admin/settings/number-series/${res.data.id}`);
  };

  const seed = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(seedStandardNumberSeriesAction());
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    const made = res.data.created.length;
    setNotice({ kind: 'ok', text: made === 0 ? 'Every document type already has a series.' : `Set up numbering for ${String(made)} document types.` });
    list.reload();
  };

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Number series"
        intro="A series decides how documents are numbered: the pattern, the range, when it restarts, and whether gaps are allowed. Tax invoices, credit notes and receipts must be gap-free."
        actions={
          <>
            <Link href="/admin/settings/number-series/bindings" className={buttonClass}>
              Document numbering
            </Link>
            {may ? (
              <>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => void seed()}>
                  Set up standard series
                </button>
                <button type="button" className={primaryClass} onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
                  New series
                </button>
              </>
            ) : null}
          </>
        }
      />
      <Message notice={notice} />

      {creating ? (
        <form onSubmit={(e) => void create(e)} className={`${cardClass} space-y-4`} aria-label="New number series">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id={`${uid}-code`} label="Code">
              <input id={`${uid}-code`} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className={`${fieldClass} font-mono`} placeholder="INV" maxLength={20} required />
            </Field>
            <Field id={`${uid}-desc`} label="Description">
              <input id={`${uid}-desc`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={fieldClass} required />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 text-xs font-semibold text-fg">Numbering mode</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {MODE_CHOICES.map((m) => (
                <label key={m.id} className={`flex min-h-10 cursor-pointer items-start gap-3 rounded-lg border p-3 ${form.mode === m.id ? 'border-indigo-500 bg-indigo-600/15' : 'border-line-strong bg-surface-sunken/60'}`}>
                  <input type="radio" name={`${uid}-mode`} checked={form.mode === m.id} onChange={() => setForm({ ...form, mode: m.id })} className="mt-1" />
                  <span>
                    <span className="block text-sm font-semibold text-fg-strong">{m.label}</span>
                    <span className="block text-xs text-fg-muted">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-fg-muted">You add the numbering lines (pattern and range) on the next screen.</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>
              Create series
            </button>
            <button type="button" className={buttonClass} onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search number series
        </label>
        <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or description" className={fieldClass} autoComplete="off" />
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

      {list.phase === 'idle' && list.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-8 text-center">
          <p className="text-sm text-fg-muted">
            {query.trim() === '' ? 'No number series yet. “Set up standard series” creates one for every document type, with sensible patterns, in one step.' : `No number series match “${query.trim()}”.`}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3" aria-label="Number series">
          {list.rows.map((s) => (
            <li key={s.id}>
              <Link href={`/admin/settings/number-series/${s.id}`} className="block rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500/40 hover:bg-hover">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-fg-strong">
                    <span className="font-mono">{s.code}</span> <span className="font-normal text-fg-muted">{s.description}</span>
                  </p>
                  <span className="flex items-center gap-2">
                    <ModeChip mode={s.mode} />
                    {s.isActive ? null : <Chip tone="gray">Inactive</Chip>}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-fg-muted">Next number</dt>
                    <dd className="font-mono text-fg-strong">{s.nextExample ?? <span className="font-sans text-amber-700">{s.nextProblem}</span>}</dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Lines</dt>
                    <dd className="text-fg-strong">{s.lineCount}</dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Numbers</dt>
                    <dd className="text-fg-strong">{s.boundTo.length === 0 ? 'Not used by any document yet' : boundWords(s.boundTo)}</dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more series'}
        </button>
      )}
    </div>
  );
}
