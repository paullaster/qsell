'use client';

import React, { use, useState, useTransition } from 'react';
import Link from 'next/link';
import { ArrowLeft, Edit2, Plus, Trash2, X } from 'lucide-react';
import type { DimensionRow, DimensionValueRow } from '@/server/db/drizzle/schema';
import {
  createDimensionValueAction,
  deleteDimensionValueAction,
  updateDimensionValueAction,
} from '@/server/domains/dimensions/actions';

const fieldClass =
  'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none';

type FormState = {
  code: string;
  name: string;
  description: string;
  parentId: string;
};

const emptyForm = (): FormState => ({
  code: '',
  name: '',
  description: '',
  parentId: '',
});

export function AdminDimensionValuesClient({
  dimensionPromise,
  valuesPromise,
  parentValuesPromise,
}: {
  dimensionPromise: Promise<DimensionRow | null>;
  valuesPromise: Promise<DimensionValueRow[]>;
  parentValuesPromise: Promise<DimensionValueRow[]>;
}) {
  const dimension = use(dimensionPromise);
  const initial = use(valuesPromise);
  const parentValues = use(parentValuesPromise);
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!dimension) {
    return (
      <p className="text-sm text-zinc-400">
        Dimension not found.{' '}
        <Link href="/admin/settings/dimensions" className="text-indigo-400 hover:underline">
          Back
        </Link>
      </p>
    );
  }

  const parentOptions = dimension.parentId ? parentValues : rows;
  const isBranchOption = dimension.optionString === 'branch';

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
  };

  const openEdit = (row: DimensionValueRow) => {
    setEditingId(row.id);
    setForm({
      code: row.code,
      name: row.name,
      description: row.description ?? '',
      parentId: row.parentId ?? '',
    });
    setError(null);
  };

  const handleSave = () => {
    startTransition(async () => {
      try {
        setError(null);
        const payload = {
          code: form.code,
          name: form.name,
          description: form.description || null,
          parentId: form.parentId || null,
        };
        if (editingId) {
          const updated = await updateDimensionValueAction(editingId, payload);
          setRows((prev) =>
            prev
              .map((r) => (r.id === updated.id ? updated : r))
              .sort((a, b) => a.code.localeCompare(b.code)),
          );
        } else {
          const created = await createDimensionValueAction({
            dimensionId: dimension.id,
            ...payload,
          });
          setRows((prev) =>
            [...prev, created].sort((a, b) => a.code.localeCompare(b.code)),
          );
        }
        openCreate();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save value');
      }
    });
  };

  const handleDelete = (row: DimensionValueRow) => {
    if (!window.confirm(`Delete value "${row.code}"?`)) return;
    startTransition(async () => {
      try {
        setError(null);
        await deleteDimensionValueAction(row.id);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        if (editingId === row.id) openCreate();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete value');
      }
    });
  };

  const toggleActive = (row: DimensionValueRow) => {
    startTransition(async () => {
      try {
        const updated = await updateDimensionValueAction(row.id, { isActive: !row.isActive });
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update value');
      }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/settings/dimensions"
          className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-indigo-400"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All dimensions
        </Link>
        <h2 className="text-xl font-bold text-white">
          {dimension.code}{' '}
          <span className="font-normal text-zinc-400">— {dimension.name}</span>
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Values for this dimension
          {dimension.optionString ? (
            <>
              {' '}
              · option <span className="font-mono text-indigo-300">{dimension.optionString}</span>
            </>
          ) : null}
          {isBranchOption ? (
            <> · each value creates/updates a real branch</>
          ) : null}
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-white">
            {editingId ? 'Edit value' : 'New value'}
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
              className={`${fieldClass} font-mono uppercase`}
              placeholder="WH-A"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-zinc-400">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
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
            <label className="mb-1 block text-[11px] font-semibold text-zinc-400">Parent value</label>
            <select
              value={form.parentId}
              onChange={(e) => setForm((p) => ({ ...p, parentId: e.target.value }))}
              className={fieldClass}
            >
              <option value="">None</option>
              {parentOptions
                .filter((v) => v.id !== editingId)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.dimensionCode}:{v.code} — {v.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          disabled={pending || !form.code || !form.name}
          onClick={handleSave}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {pending ? 'Saving…' : editingId ? 'Save changes' : 'Add value'}
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
              <th className="px-4 py-3">Parent</th>
              <th className="px-4 py-3">Status</th>
              {isBranchOption ? <th className="px-4 py-3">Branch</th> : null}
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={isBranchOption ? 6 : 5}
                  className="px-4 py-8 text-center text-zinc-500"
                >
                  No values yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const parent =
                  parentOptions.find((p) => p.id === row.parentId) ||
                  rows.find((p) => p.id === row.parentId);
                return (
                  <tr key={row.id} className="bg-zinc-900/40">
                    <td className="px-4 py-3 font-mono text-indigo-300">{row.code}</td>
                    <td className="px-4 py-3 text-white">{row.name}</td>
                    <td className="px-4 py-3 text-zinc-500">{parent?.code || '—'}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => toggleActive(row)}
                        className={
                          row.isActive
                            ? 'text-[11px] font-semibold text-emerald-400'
                            : 'text-[11px] font-semibold text-zinc-500'
                        }
                      >
                        {row.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    {isBranchOption ? (
                      <td className="px-4 py-3 font-mono text-[10px] text-zinc-500">
                        {row.linkedBranchId ? row.linkedBranchId.slice(0, 8) : '—'}
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
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
