'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import {
  createDimensionValueAction,
  deleteDimensionValueAction,
  dimensionValuesPageAction,
  type getDimensionAction,
  updateDimensionValueAction,
  type DimensionValueView,
} from '@/server/domains/dimensions/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import { buttonClass, cardClass, Chip, Field, fieldClass, LoadFailed, Message, PageHeader, primaryClass, attempt, type Notice } from '@/components/ui/screen-kit';
import { emptyValueForm, parentValueDimension, valuePayload, type DimensionValueForm } from '@/lib/dimension-forms';
import { has } from '@/lib/values';
import { savedWords, submitWords } from '@/lib/form-words';
import type { Choice } from '@/lib/payment-options';

type Dimension = Extract<Awaited<ReturnType<typeof getDimensionAction>>, { ok: true }>['data'];
type FirstPage = Awaited<ReturnType<typeof dimensionValuesPageAction>>;

interface Props {
  dimensionPromise: ReturnType<typeof getDimensionAction>;
  firstPage: ReturnType<typeof dimensionValuesPageAction>;
  canManage: Promise<boolean>;
}

export function AdminDimensionValuesClient({ dimensionPromise, firstPage, canManage }: Props) {
  const dimension = use(dimensionPromise);
  const first = use(firstPage);
  const may = use(canManage);
  if (!dimension.ok) return <LoadFailed error={dimension.error} />;
  if (!first.ok) return <LoadFailed error={first.error} />;
  return <ValuesView dimension={dimension.data} first={first} may={may} />;
}

function ValuesView({ dimension, first, may }: { dimension: Dimension; first: FirstPage; may: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<DimensionValueForm>(emptyValueForm);
  const [parent, setParent] = useState<Choice | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<DimensionValueView, { query: string }>({
    load: (filters, cursor) => dimensionValuesPageAction(dimension.id, { query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  const reset = () => {
    setEditingId(null);
    setForm(emptyValueForm());
    setParent(null);
  };
  const edit = (row: DimensionValueView) => {
    setNotice(null);
    setEditingId(row.id);
    setForm({ code: row.code, name: row.name, description: row.description ?? '', parentId: row.parentId ?? '' });
    setParent(row.parentId === null ? null : { id: row.parentId, label: row.parentLabel ?? row.parentId });
  };
  const finish = (ok: boolean, text: string) => {
    setBusy(false);
    setNotice({ kind: ok ? 'ok' : 'error', text });
    if (ok) list.reload();
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = valuePayload({ ...form, parentId: parent?.id ?? '' });
    if (!checked.ok) {
      setNotice({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    const res = editingId === null ? await attempt(createDimensionValueAction({ dimensionId: dimension.id, ...checked.payload })) : await attempt(updateDimensionValueAction(editingId, checked.payload));
    if (res.ok) reset();
    finish(res.ok, res.ok ? savedWords(editingId, 'Value') : res.error);
  };
  const toggleActive = async (row: DimensionValueView) => {
    setBusy(true);
    const res = await attempt(updateDimensionValueAction(row.id, { isActive: !row.isActive }));
    finish(res.ok, res.ok ? `${row.code} is ${row.isActive ? 'switched off' : 'switched on'}.` : res.error);
  };
  const remove = async (row: DimensionValueView) => {
    setBusy(true);
    const res = await attempt(deleteDimensionValueAction(row.id));
    if (res.ok && editingId === row.id) reset();
    finish(res.ok, res.ok ? `${row.code} deleted.` : res.error);
  };

  const filters = { dimension: parentValueDimension(dimension), ...(editingId === null ? {} : { exclude: editingId }) };

  return (
    <div className="max-w-6xl space-y-5">
      <Link href="/admin/settings/dimensions" className="inline-flex min-h-10 items-center text-xs text-fg-subtle hover:text-indigo-500">
        ← All dimensions
      </Link>
      <PageHeader
        title={`${dimension.code} — ${dimension.name}`}
        intro={
          <>
            Values for this dimension
            {has(dimension.optionLabel) ? <> · option {dimension.optionLabel}</> : null}
            {dimension.optionString === 'branch' ? ' · each value creates or updates a real branch' : null}
          </>
        }
      />
      <Message notice={notice} />

      {may ? (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-4`} aria-label={editingId === null ? 'New value' : 'Edit value'}>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-fg-strong">{editingId === null ? 'New value' : 'Edit value'}</h3>
            {editingId === null ? null : (
              <button type="button" className={buttonClass} onClick={reset}>
                Cancel
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id={`${uid}-code`} label="Code">
              <input id={`${uid}-code`} value={form.code} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))} placeholder="WH-A" className={`${fieldClass} font-mono uppercase`} required />
            </Field>
            <Field id={`${uid}-name`} label="Name">
              <input id={`${uid}-name`} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className={fieldClass} required />
            </Field>
            <div className="sm:col-span-2">
              <Field id={`${uid}-desc`} label="Description">
                <input id={`${uid}-desc`} value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} className={fieldClass} />
              </Field>
            </div>
            <ChoicePicker label="Parent value" source="dimension-values" filters={filters} choice={parent} onChoice={setParent} placeholder="None" />
          </div>
          <button type="submit" disabled={busy} className={primaryClass}>
            {submitWords(busy, editingId, 'Create value')}
          </button>
        </form>
      ) : null}

      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search values
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

      <ul className="space-y-2" aria-label="Values">
        {list.rows.map((row) => (
          <li key={row.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-fg-strong">
                  <span className="font-mono">{row.code}</span> · {row.name}
                </p>
                <p className="mt-1 flex flex-wrap gap-1.5">
                  <Chip tone={row.isActive ? 'green' : 'gray'}>{row.isActive ? 'In use' : 'Switched off'}</Chip>
                  {has(row.parentLabel) ? <Chip tone="gray">Under {row.parentLabel}</Chip> : null}
                </p>
              </div>
              {may ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={buttonClass} onClick={() => void toggleActive(row)} disabled={busy} aria-label={`${row.isActive ? 'Switch off' : 'Switch on'} ${row.code}`}>
                    {row.isActive ? 'Switch off' : 'Switch on'}
                  </button>
                  <button type="button" className={buttonClass} onClick={() => edit(row)} disabled={busy} aria-label={`Edit ${row.code}`}>
                    Edit
                  </button>
                  <InlineConfirm label={`Delete value ${row.code}`} action="Delete" confirm="Delete for good" busy={busy} onConfirm={() => void remove(row)} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted">{query.trim() === '' ? 'No values yet.' : `No values match “${query.trim()}”.`}</p> : null}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more values'}
        </button>
      )}
    </div>
  );
}
