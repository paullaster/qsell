'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createDimensionAction,
  deleteDimensionAction,
  dimensionsPageAction,
  updateDimensionAction,
  type DimensionView,
} from '@/server/domains/dimensions/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import { buttonClass, cardClass, Chip, Field, fieldClass, LoadFailed, Message, PageHeader, primaryClass, attempt, type Notice } from '@/components/ui/screen-kit';
import {
  applyFlagChange,
  dimensionPayload,
  emptyDimensionForm,
  formFromDimension,
  needsDimensionNo,
  toggledFlags,
  type DimensionFlags,
  type DimensionForm,
} from '@/lib/dimension-forms';
import { has } from '@/lib/values';
import { savedWords, submitWords } from '@/lib/form-words';
import type { Choice } from '@/lib/payment-options';

type FirstPage = Awaited<ReturnType<typeof dimensionsPageAction>>;

export function AdminDimensionsClient({ firstPage, canManage }: { firstPage: ReturnType<typeof dimensionsPageAction>; canManage: Promise<boolean> }) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <DimensionsView first={first} may={may} /> : <LoadFailed error={first.error} />;
}

const FLAGS: { key: keyof DimensionFlags; label: string }[] = [
  { key: 'isDefault', label: 'Default' },
  { key: 'isGlobal', label: 'Global' },
  { key: 'isShortcut', label: 'Shortcut' },
];

function DimensionsView({ first, may }: { first: FirstPage; may: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<DimensionForm>(emptyDimensionForm);
  const [parent, setParent] = useState<Choice | null>(null);
  const [option, setOption] = useState<Choice | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<DimensionView, { query: string }>({
    load: (filters, cursor) => dimensionsPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  const reset = () => {
    setEditingId(null);
    setForm(emptyDimensionForm());
    setParent(null);
    setOption(null);
  };
  const edit = (row: DimensionView) => {
    setNotice(null);
    setEditingId(row.id);
    setForm(formFromDimension(row));
    setParent(row.parentId === null ? null : { id: row.parentId, label: row.parentCode ?? row.parentId });
    setOption(row.optionString === null ? null : { id: row.optionString, label: row.optionLabel ?? row.optionString });
  };
  const finish = (ok: boolean, text: string) => {
    setBusy(false);
    setNotice({ kind: ok ? 'ok' : 'error', text });
    if (ok) {
      list.reload();
      router.refresh();
    }
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = dimensionPayload({ ...form, parentId: parent?.id ?? '', optionString: option?.id ?? '' });
    if (!checked.ok) {
      setNotice({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    const res = editingId === null ? await attempt(createDimensionAction(checked.payload)) : await attempt(updateDimensionAction(editingId, checked.payload));
    if (res.ok) reset();
    finish(res.ok, res.ok ? savedWords(editingId, 'Dimension') : res.error);
  };
  const toggle = async (row: DimensionView, flag: keyof DimensionFlags, value: boolean) => {
    setBusy(true);
    const res = await attempt(updateDimensionAction(row.id, toggledFlags(row, flag, value)));
    finish(res.ok, res.ok ? `${row.code} updated.` : res.error);
  };
  const remove = async (row: DimensionView) => {
    setBusy(true);
    const res = await attempt(deleteDimensionAction(row.id));
    if (res.ok && editingId === row.id) reset();
    finish(res.ok, res.ok ? `${row.code} deleted.` : res.error);
  };

  const setFlag = (change: Partial<DimensionFlags>) => setForm((prev) => ({ ...prev, ...applyFlagChange(prev, change) }));
  const set = <K extends keyof DimensionForm>(key: K, value: DimensionForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const filters = editingId === null ? undefined : { exclude: editingId };

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Dimensions"
        intro="Define classification axes and values to identify any record. The option string “branch” syncs values into the branches table. A default dimension is always global; global and shortcut cannot both be on."
      />
      <Message notice={notice} />

      {may ? (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-4`} aria-label={editingId === null ? 'New dimension' : 'Edit dimension'}>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-fg-strong">{editingId === null ? 'New dimension' : 'Edit dimension'}</h3>
            {editingId === null ? null : (
              <button type="button" className={buttonClass} onClick={reset}>
                Cancel
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id={`${uid}-code`} label="Code">
              <input id={`${uid}-code`} value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="WAREHOUSE" className={`${fieldClass} font-mono uppercase`} required />
            </Field>
            <Field id={`${uid}-name`} label="Name">
              <input id={`${uid}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Warehouse" className={fieldClass} required />
            </Field>
            <div className="sm:col-span-2">
              <Field id={`${uid}-desc`} label="Description">
                <input id={`${uid}-desc`} value={form.description} onChange={(e) => set('description', e.target.value)} className={fieldClass} />
              </Field>
            </div>
            <ChoicePicker label="Parent" source="dimensions" filters={filters} choice={parent} onChoice={setParent} placeholder="None" />
            <Field id={`${uid}-no`} label={`Dimension number ${needsDimensionNo(form) ? '(required)' : '(optional)'}`}>
              <input id={`${uid}-no`} type="number" min={1} step={1} inputMode="numeric" value={form.dimensionNo} onChange={(e) => set('dimensionNo', e.target.value)} className={fieldClass} placeholder="1" />
            </Field>
            <ChoicePicker label="Option string" source="dimension-option-strings" choice={option} onChoice={setOption} placeholder="None" />
            <fieldset className="flex flex-wrap items-end gap-4 pb-1">
              <legend className="sr-only">How it is offered</legend>
              {FLAGS.map((f) => (
                <label key={f.key} className="flex min-h-10 items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={form[f.key]}
                    disabled={(f.key === 'isGlobal' && form.isDefault) || (f.key === 'isShortcut' && (form.isDefault || form.isGlobal))}
                    onChange={(e) => setFlag({ [f.key]: e.target.checked })}
                  />
                  {f.label}
                </label>
              ))}
            </fieldset>
          </div>
          <button type="submit" disabled={busy} className={primaryClass}>
            {submitWords(busy, editingId, 'Create dimension')}
          </button>
        </form>
      ) : null}

      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search dimensions
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

      <ul className="space-y-2" aria-label="Dimensions">
        {list.rows.map((row) => (
          <li key={row.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-fg-strong">
                  <span className="font-mono">{row.code}</span> · {row.name}
                </p>
                <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-fg-muted">
                  {row.dimensionNo === null ? null : <Chip tone="gray">No. {row.dimensionNo}</Chip>}
                  {has(row.optionLabel) ? <Chip tone="sky">{row.optionLabel}</Chip> : null}
                  {has(row.parentCode) ? <Chip tone="gray">Under {row.parentCode}</Chip> : null}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link className={buttonClass} href={`/admin/settings/dimensions/${row.id}`} aria-label={`Values of ${row.code}`}>
                  Values
                </Link>
                {may ? (
                  <>
                    <button type="button" className={buttonClass} onClick={() => edit(row)} disabled={busy} aria-label={`Edit ${row.code}`}>
                      Edit
                    </button>
                    <InlineConfirm label={`Delete dimension ${row.code}`} action="Delete" confirm="Delete with its values" busy={busy} onConfirm={() => void remove(row)} />
                  </>
                ) : null}
              </div>
            </div>
            <fieldset className="mt-3 flex flex-wrap gap-x-4 text-sm text-fg">
              <legend className="sr-only">Flags of {row.code}</legend>
              {FLAGS.map((f) => (
                <label key={f.key} className="flex min-h-10 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={row[f.key]}
                    disabled={!may || busy || (f.key === 'isGlobal' && row.isDefault) || (f.key === 'isShortcut' && (row.isDefault || row.isGlobal))}
                    onChange={(e) => void toggle(row, f.key, e.target.checked)}
                  />
                  {f.label}
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted">{query.trim() === '' ? 'No dimensions yet.' : `No dimensions match “${query.trim()}”.`}</p> : null}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more dimensions'}
        </button>
      )}
    </div>
  );
}
