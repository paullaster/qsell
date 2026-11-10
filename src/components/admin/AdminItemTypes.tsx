'use client';

import React, { use, useState } from 'react';
import { Tags, Plus, Search, Edit2, Check, X, Package, Star } from 'lucide-react';
import { type ItemType, type Product } from '@/types/index';
import type { InventoryKind } from '@/lib/inventory-kind';
import { BehavesAsField, inventoryKindLabel } from '@/components/admin/BehavesAsField';
import {
  createItemTypeAction,
  updateItemTypeAction,
  itemTypeChangeAction,
  deleteItemTypeAction,
  setDefaultItemTypeAction,
} from '@/server/actions';
import type { ItemTypeChangeView } from '@/lib/item-type-impact';
import { InlineConfirm } from '@/components/ui/InlineConfirm';

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
  const [behavesAs, setBehavesAs] = useState<InventoryKind>('inventory');
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** What saving would do to the classification's products, shown before the person confirms. */
  const [pendingChange, setPendingChange] = useState<ItemTypeChangeView | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const submitLabel = editing === null ? 'Create' : 'Save changes';

  const filtered = itemTypes.filter((t) => {
    const q = search.toLowerCase();
    return t.name.toLowerCase().includes(q) || String(t.code).includes(q);
  });

  const openCreate = () => {
    setEditing(null);
    setName('');
    setCode('');
    setIsSellable(true);
    setBehavesAs('inventory');
    setIsDefault(itemTypes.length === 0);
    setIsActive(true);
    setFormError(null);
    setPendingChange(null);
    setIsModalOpen(true);
  };

  const openEdit = (type: ItemType) => {
    setEditing(type);
    setName(type.name);
    setCode(String(type.code));
    setIsSellable(type.isSellable);
    setBehavesAs(type.defaultInventoryKind);
    setIsDefault(type.isDefault);
    setIsActive(type.isActive);
    setFormError(null);
    setPendingChange(null);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: { preventDefault: () => void }, confirmed = false) => {
    e.preventDefault();
    if (name.trim() === '') {
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
        // Changing whether the classification is sold changes its products too: say how many before it happens.
        if (isSellable !== editing.isSellable && !confirmed) {
          const check = await itemTypeChangeAction(editing.id, isSellable);
          if (!check.ok) {
            setFormError(check.error);
            return;
          }
          if (check.data.blocked !== null) {
            setFormError(check.data.blocked);
            return;
          }
          setPendingChange(check.data);
          return;
        }
        const saved = await updateItemTypeAction(editing.id, {
          name: name.trim(),
          code: parsedCode,
          isSellable,
          defaultInventoryKind: behavesAs,
          isDefault,
          isActive,
        });
        if (!saved.ok) {
          setFormError(saved.error);
          setPendingChange(null);
          return;
        }
        if (isDefault && !editing.isDefault) {
          await setDefaultItemTypeAction(editing.id);
        }
      } else {
        await createItemTypeAction({
          name: name.trim(),
          code: parsedCode,
          isSellable,
          defaultInventoryKind: behavesAs,
          isDefault: itemTypes.length === 0 ? true : isDefault,
          isActive,
        });
      }

      setIsModalOpen(false);
      onRefresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save business classification');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (type: ItemType) => {
    setPageError(null);
    if (type.isDefault) {
      setPageError('This is the default business classification. Make another one the default before deleting it.');
      return;
    }
    try {
      await deleteItemTypeAction(type.id);
      onRefresh();
    } catch (err: unknown) {
      setPageError(err instanceof Error ? err.message : 'The business classification could not be deleted.');
    }
  };

  const handleSetDefault = async (type: ItemType) => {
    try {
      await setDefaultItemTypeAction(type.id);
      onRefresh();
    } catch (err: unknown) {
      setPageError(err instanceof Error ? err.message : 'The default could not be changed.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
            <Tags className="h-5 w-5 text-indigo-400" />
            Business classifications
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Describe what a product is in your business and whether it is sold to customers. Each
            classification keeps its existing tax-authority code. It also says whether its products
            are stocked goods, goods that are not stocked, or services; a new product starts with
            that and keeps its own after.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" />
          Add business classification
        </button>
      </div>

      {pageError === null ? null : (
        <p role="alert" className="rounded-lg border border-red-800 bg-red-50/50 px-3 py-2 text-xs text-red-800">
          {pageError}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or code…"
            className="w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line bg-surface text-[10px] tracking-wider text-fg-subtle uppercase">
            <tr>
              <th className="px-4 py-3">Tax code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Behaves as</th>
              <th className="px-4 py-3 text-center">Sold to customers</th>
              <th className="px-4 py-3 text-center">Default</th>
              <th className="px-4 py-3 text-center">Products</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/80 bg-surface-sunken/40">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-fg-subtle">
                  No business classifications yet. Create one to classify products.
                </td>
              </tr>
            ) : (
              filtered.map((type) => (
                <tr key={type.id} className="hover:bg-hover">
                  <td className="px-4 py-3 font-mono text-fg">{type.code}</td>
                  <td className="px-4 py-3 font-semibold text-fg-strong">{type.name}</td>
                  <td className="px-4 py-3 text-fg">{inventoryKindLabel(type.defaultInventoryKind)}</td>
                  <td className="px-4 py-3 text-center">
                    {type.isSellable ? (
                      <span className="text-emerald-600">Yes</span>
                    ) : (
                      <span className="text-fg-subtle">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {type.isDefault ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/50 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        <Star className="h-3 w-3" /> Default
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSetDefault(type)}
                        className="text-[10px] text-fg-subtle hover:text-indigo-400"
                      >
                        Make default
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-fg">
                      <Package className="h-3 w-3" />
                      {type.productCount ?? 0}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        type.isActive
                          ? 'border border-emerald-800 bg-emerald-50/60 text-emerald-700'
                          : 'border border-line-strong bg-surface-sunken text-fg-muted'
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
                        aria-label={`Edit ${type.name}`}
                        className="rounded-lg bg-surface-sunken p-1.5 text-fg hover:bg-hover hover:text-fg-strong"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <InlineConfirm
                        label={`Delete business classification ${type.name}`}
                        action="Delete"
                        confirm="Yes, delete"
                        onConfirm={() => void handleDelete(type)}
                      />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/80 p-4 backdrop-blur-sm">
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-fg-strong">
                {editing ? 'Edit business classification' : 'Create business classification'}
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg p-1 text-fg-muted hover:text-fg-strong"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError !== null && formError !== '' ? (
              <div className="rounded-lg border border-red-800 bg-red-50/50 px-3 py-2 text-xs text-red-800">
                {formError}
              </div>
            ) : null}

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-fg-muted">Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Finished product, Raw material"
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold text-fg-muted">
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
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-fg-subtle">
                Integer value provided by the tax authority for e-invoicing / compliance.
              </p>
            </div>

            <BehavesAsField value={behavesAs} onChange={setBehavesAs} />

            <div className="flex flex-wrap gap-4 text-xs text-fg">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isSellable}
                  onChange={(e) => {
                    setIsSellable(e.target.checked);
                    setPendingChange(null);
                  }}
                  className="rounded border-line-strong"
                />
                Sold to customers
              </label>
              <p className="basis-full text-[11px] text-fg-subtle">
                Applies wherever products are sold: the web shop, quotes, orders and the invoices made from them. Products of a
                classification that is not sold cannot be added to any of them.
              </p>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  disabled={editing?.isDefault}
                  className="rounded border-line-strong"
                />
                Default for new products
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="rounded border-line-strong"
                />
                Active
              </label>
            </div>

            {pendingChange === null ? null : (
              <div role="status" className="space-y-2 rounded-lg border border-amber-700/50 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <p className="font-semibold">
                  {pendingChange.effect === 'stop' ? 'Stop selling this classification?' : 'Start selling this classification?'}
                </p>
                <p>{pendingChange.message}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={(event) => void handleSubmit(event, true)}
                    className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {isSubmitting ? 'Saving…' : 'Yes, save and apply'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingChange(null)}
                    className="min-h-10 rounded-lg bg-surface-sunken px-4 py-2 text-xs font-medium text-fg hover:bg-hover"
                  >
                    Go back
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg bg-surface-sunken px-4 py-2 text-xs font-medium text-fg hover:bg-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {isSubmitting ? 'Saving…' : submitLabel}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
