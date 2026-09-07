'use client';

import React, { use, useState } from 'react';
import {
  Tags,
  Plus,
  Search,
  Edit2,
  Trash2,
  Check,
  X,
  Package,
  Star,
} from 'lucide-react';
import { type ItemType, type Product } from '@/types/index';
import {
  createItemTypeAction,
  updateItemTypeAction,
  deleteItemTypeAction,
  setDefaultItemTypeAction,
} from '@/server/actions';

interface AdminItemTypesProps {
  itemTypesPromise: Promise<ItemType[]>;
  productsPromise: Promise<Product[]>;
  onRefresh: () => void;
}

export function AdminItemTypes({
  itemTypesPromise,
  productsPromise,
  onRefresh,
}: AdminItemTypesProps) {
  const itemTypes = use(itemTypesPromise);
  use(productsPromise); // keep cache warm / future product counts already on itemTypes

  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<ItemType | null>(null);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [isSellable, setIsSellable] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const filtered = itemTypes.filter((t) => {
    const q = search.toLowerCase();
    return (
      t.name.toLowerCase().includes(q) ||
      String(t.code).includes(q)
    );
  });

  const openCreate = () => {
    setEditing(null);
    setName('');
    setCode('');
    setIsSellable(true);
    setIsDefault(itemTypes.length === 0);
    setIsActive(true);
    setFormError(null);
    setIsModalOpen(true);
  };

  const openEdit = (type: ItemType) => {
    setEditing(type);
    setName(type.name);
    setCode(String(type.code));
    setIsSellable(type.isSellable);
    setIsDefault(type.isDefault);
    setIsActive(type.isActive);
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Item type name is required.');
      return;
    }

    const parsedCode = code.trim() === '' ? NaN : Number(code);
    if (!Number.isInteger(parsedCode) || parsedCode < 0) {
      setFormError('Enter the integer code assigned by the tax authority.');
      return;
    }

    try {
      setIsSubmitting(true);
      setFormError(null);

      if (editing) {
        await updateItemTypeAction(editing.id, {
          name: name.trim(),
          code: parsedCode,
          isSellable,
          isDefault,
          isActive,
        });
        if (isDefault && !editing.isDefault) {
          await setDefaultItemTypeAction(editing.id);
        }
      } else {
        await createItemTypeAction({
          name: name.trim(),
          code: parsedCode,
          isSellable,
          isDefault: itemTypes.length === 0 ? true : isDefault,
          isActive,
        });
      }

      setIsModalOpen(false);
      onRefresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save item type');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (type: ItemType) => {
    if (
      !window.confirm(
        type.isDefault
          ? 'This is the default item type. Set another default before deleting.'
          : `Delete item type "${type.name}"?`,
      )
    ) {
      return;
    }
    try {
      await deleteItemTypeAction(type.id);
      onRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleSetDefault = async (type: ItemType) => {
    try {
      await setDefaultItemTypeAction(type.id);
      onRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to set default');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-white">
            <Tags className="h-5 w-5 text-indigo-400" />
            Item Types
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Classify products for catalog and tax compliance. Each type needs the integer code
            issued by the tax authority. Exactly one type is the default for new products.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" />
          Add item type
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or code…"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-2 pr-3 pl-9 text-sm text-white placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-[10px] tracking-wider text-zinc-500 uppercase">
            <tr>
              <th className="px-4 py-3">Tax code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3 text-center">Sellable</th>
              <th className="px-4 py-3 text-center">Default</th>
              <th className="px-4 py-3 text-center">Products</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/80 bg-zinc-900/40">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-zinc-500">
                  No item types yet. Create one to classify products.
                </td>
              </tr>
            ) : (
              filtered.map((type) => (
                <tr key={type.id} className="hover:bg-zinc-800/40">
                  <td className="px-4 py-3 font-mono text-zinc-300">{type.code}</td>
                  <td className="px-4 py-3 font-semibold text-white">{type.name}</td>
                  <td className="px-4 py-3 text-center">
                    {type.isSellable ? (
                      <span className="text-emerald-400">Yes</span>
                    ) : (
                      <span className="text-zinc-500">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {type.isDefault ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/50 bg-amber-950/40 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                        <Star className="h-3 w-3" /> Default
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSetDefault(type)}
                        className="text-[10px] text-zinc-500 hover:text-indigo-400"
                      >
                        Make default
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">
                      <Package className="h-3 w-3" />
                      {type.productCount ?? 0}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        type.isActive
                          ? 'border border-emerald-800 bg-emerald-950/60 text-emerald-300'
                          : 'border border-zinc-700 bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {type.isActive ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {type.isActive ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEdit(type)}
                        className="rounded-lg bg-zinc-800 p-1.5 text-zinc-300 hover:bg-zinc-700 hover:text-white"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(type)}
                        className="rounded-lg bg-zinc-800 p-1.5 text-zinc-300 hover:bg-red-900/50 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-md space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">
                {editing ? 'Edit item type' : 'Create item type'}
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg p-1 text-zinc-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError ? (
              <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-200">
                {formError}
              </div>
            ) : null}

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-zinc-400">Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Finished product, Raw material"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-zinc-400">
                Tax authority code *
              </label>
              <input
                type="number"
                min={0}
                step={1}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. 1"
                required
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-white placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                Integer value provided by the tax authority for e-invoicing / compliance.
              </p>
            </div>

            <div className="flex flex-wrap gap-4 text-xs text-zinc-300">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isSellable}
                  onChange={(e) => setIsSellable(e.target.checked)}
                  className="rounded border-zinc-700"
                />
                Sellable on storefront
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  disabled={editing?.isDefault}
                  className="rounded border-zinc-700"
                />
                Default for new products
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="rounded border-zinc-700"
                />
                Active
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {isSubmitting ? 'Saving…' : editing ? 'Save changes' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
