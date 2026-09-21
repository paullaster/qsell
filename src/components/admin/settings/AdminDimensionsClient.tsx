'use client';

import React, { use, useState, useTransition } from 'react';
import Link from 'next/link';
import { Edit2, Layers, Plus, Trash2, X } from 'lucide-react';
import type { DimensionRow } from '@/server/db/drizzle/schema';
import {
  createDimensionAction,
  deleteDimensionAction,
  updateDimensionAction,
} from '@/server/domains/dimensions/actions';

const fieldClass =
  'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none';

type OptionItem = { value: string; label: string };

type FormState = {
  code: string;
  name: string;
  description: string;
  parentId: string;
  dimensionNo: string;
  isGlobal: boolean;
  isDefault: boolean;
  isShortcut: boolean;
  optionString: string;
};

const emptyForm = (): FormState => ({
  code: '',
  name: '',
  description: '',
  parentId: '',
  dimensionNo: '',
  isGlobal: false,
  isDefault: false,
  isShortcut: false,
  optionString: '',
});

export function AdminDimensionsClient({
  dimensionsPromise,
  optionsPromise,
}: {
  dimensionsPromise: Promise<DimensionRow[]>;
  optionsPromise: Promise<OptionItem[]>;
}) {
  const initial = use(dimensionsPromise);
  const optionItems = use(optionsPromise);
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const applyFlagDefaults = (next: {
    isDefault?: boolean;
    isGlobal?: boolean;
    isShortcut?: boolean;
  }) => {
    let d = next.isDefault ?? form.isDefault;
    let g = next.isGlobal ?? form.isGlobal;
    let s = next.isShortcut ?? form.isShortcut;
    if (d) {
      g = true;
      s = false;
    }
    if (g && s) s = false;
    if (next.isShortcut && !d) {
      s = true;
      g = false;
    }
    if (next.isGlobal && !next.isDefault) {
      g = true;
      s = false;
    }
    setForm((prev) => ({ ...prev, isDefault: d, isGlobal: g, isShortcut: s }));
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
  };

  const openEdit = (row: DimensionRow) => {
    setEditingId(row.id);
    setForm({
      code: row.code,
      name: row.name,
      description: row.description ?? '',
      parentId: row.parentId ?? '',
      dimensionNo: row.dimensionNo != null ? String(row.dimensionNo) : '',
      isGlobal: row.isGlobal,
      isDefault: row.isDefault,
      isShortcut: row.isShortcut,
      optionString: row.optionString ?? '',
    });
    setError(null);
  };

  const handleSave = () => {
    startTransition(async () => {
      try {
        setError(null);
        if ((form.isGlobal || form.isShortcut || form.isDefault) && !form.dimensionNo) {
          setError('dimension_no is required for global and shortcut dimensions.');
          return;
        }
        const payload = {
          code: form.code,
          name: form.name,
          description: form.description || null,
          parentId: form.parentId || null,
          dimensionNo: form.dimensionNo ? Number(form.dimensionNo) : null,
          isGlobal: form.isGlobal,
          isDefault: form.isDefault,
          isShortcut: form.isShortcut,
          optionString: form.optionString || null,
        };
        if (editingId) {
          const updated = await updateDimensionAction(editingId, payload);
          setRows((prev) =>
            prev.map((r) => (r.id === updated.id ? updated : r)).sort((a, b) =>
              a.code.localeCompare(b.code),
            ),
          );
        } else {
          const created = await createDimensionAction(payload);
          setRows((prev) =>
            [...prev, created].sort((a, b) => a.code.localeCompare(b.code)),
          );
        }
        openCreate();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save dimension');
      }
    });
  };

  const handleDelete = (row: DimensionRow) => {
    if (!window.confirm(`Delete dimension "${row.code}" and all its values?`)) return;
    startTransition(async () => {
      try {
        setError(null);
        await deleteDimensionAction(row.id);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        if (editingId === row.id) openCreate();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete dimension');
      }
    });
  };

  const toggleFlag = (
    row: DimensionRow,
    flag: 'isGlobal' | 'isDefault' | 'isShortcut',
    value: boolean,
  ) => {
    startTransition(async () => {
      try {
        setError(null);
        const patch: {
          isGlobal?: boolean;
          isDefault?: boolean;
          isShortcut?: boolean;
        } = {
          isGlobal: row.isGlobal,
          isDefault: row.isDefault,
          isShortcut: row.isShortcut,
        };
        patch[flag] = value;
        if (flag === 'isDefault' && value) {
          patch.isGlobal = true;
          patch.isShortcut = false;
        }
        if (flag === 'isGlobal' && value) patch.isShortcut = false;
        if (flag === 'isShortcut' && value) {
          patch.isGlobal = false;
          patch.isDefault = false;
        }
        const updated = await updateDimensionAction(row.id, patch);
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update dimension');
      }
    });
  };

  const parentChoices = rows.filter((r) => r.id !== editingId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-white">
          <Layers className="h-5 w-5 text-indigo-400" />
          Dimensions
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-400">
          Define classification axes and values to identify any record. Option string{' '}
          <span className="font-mono text-indigo-300">branch</span> syncs values into the
          branches table. Default always becomes global; global and shortcut cannot both be on.
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-white">
            {editingId ? 'Edit dimension' : 'New dimension'}
          </h3>
          {editingId ? (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-white"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-zinc-400">Code</label>
            <input
              value={form.code}
              onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
              placeholder="WAREHOUSE"
              className={`${fieldClass} font-mono uppercase`}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-zinc-400">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Warehouse"
              className={fieldClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-semibold text-zinc-400">Description</label>
            <input
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              className={fieldClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-zinc-400">Parent</label>
            <select
              value={form.parentId}
              onChange={(e) => setForm((p) => ({ ...p, parentId: e.target.value }))}
              className={fieldClass}
            >
              <option value="">None</option>
              {parentChoices.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} — {r.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-zinc-400">
              Dimension no.{' '}
              {form.isGlobal || form.isShortcut || form.isDefault ? '(required)' : '(optional)'}
            </label>
            <input
              type="number"
              min={1}
              value={form.dimensionNo}
              onChange={(e) => setForm((p) => ({ ...p, dimensionNo: e.target.value }))}
              className={fieldClass}
              placeholder="1"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-zinc-400">
              Option string
            </label>
            <select
              value={form.optionString}
              onChange={(e) => setForm((p) => ({ ...p, optionString: e.target.value }))}
              className={fieldClass}
            >
              <option value="">None</option>
              {optionItems.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-end gap-4 pb-1 text-sm text-zinc-300">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => applyFlagDefaults({ isDefault: e.target.checked })}
              />
              Default
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isGlobal}
                onChange={(e) => applyFlagDefaults({ isGlobal: e.target.checked })}
                disabled={form.isDefault}
              />
              Global
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isShortcut}
                onChange={(e) => applyFlagDefaults({ isShortcut: e.target.checked })}
                disabled={form.isDefault || form.isGlobal}
              />
              Shortcut
            </label>
          </div>
        </div>
        <button
          type="button"
          disabled={pending || !form.code || !form.name}
          onClick={handleSave}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {pending ? 'Saving…' : editingId ? 'Save changes' : 'Create dimension'}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-[10px] tracking-wider text-zinc-500 uppercase">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">No.</th>
              <th className="px-4 py-3">Option</th>
              <th className="px-4 py-3">Flags</th>
              <th className="px-4 py-3">Parent</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                  No dimensions yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const parent = rows.find((r) => r.id === row.parentId);
                return (
                  <tr key={row.id} className="bg-zinc-900/40">
                    <td className="px-4 py-3 font-mono text-indigo-300">{row.code}</td>
                    <td className="px-4 py-3 text-white">{row.name}</td>
                    <td className="px-4 py-3 font-mono text-zinc-300">{row.dimensionNo ?? '—'}</td>
                    <td className="px-4 py-3 text-zinc-400">{row.optionString || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-3 text-[11px] text-zinc-300">
                        <label className="inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={row.isDefault}
                            disabled={pending}
                            onChange={(e) => toggleFlag(row, 'isDefault', e.target.checked)}
                          />
                          Default
                        </label>
                        <label className="inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={row.isGlobal}
                            disabled={pending || row.isDefault}
                            onChange={(e) => toggleFlag(row, 'isGlobal', e.target.checked)}
                          />
                          Global
                        </label>
                        <label className="inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={row.isShortcut}
                            disabled={pending || row.isDefault || row.isGlobal}
                            onChange={(e) => toggleFlag(row, 'isShortcut', e.target.checked)}
                          />
                          Shortcut
                        </label>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-500">{parent?.code || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/admin/settings/dimensions/${row.id}`}
                          className="text-indigo-400 hover:underline"
                        >
                          Values
                        </Link>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => openEdit(row)}
                          className="text-zinc-400 hover:text-white"
                          title="Edit"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => handleDelete(row)}
                          className="text-zinc-400 hover:text-red-400"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
