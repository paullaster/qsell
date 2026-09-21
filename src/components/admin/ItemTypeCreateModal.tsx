'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Tags, X } from 'lucide-react';
import { createItemTypeAction } from '@/server/actions';
import { publishCatalogShortcut } from '@/components/admin/catalog-shortcuts';

export function ItemTypeCreateModal({ presentation }: { presentation: 'intercepted' | 'page' }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [isSellable, setIsSellable] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push('/admin/item-types');
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
      const itemType = await createItemTypeAction({
        name: name.trim(),
        code: parsedCode,
        isSellable,
        isDefault,
        isActive,
      });

      if (presentation === 'intercepted') {
        publishCatalogShortcut({ kind: 'itemType', itemType });
        router.back();
      } else {
        router.push('/admin/item-types');
        router.refresh();
      }
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save item type');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Tags className="h-5 w-5 text-indigo-400" />
            <div>
              <h3 className="text-base font-bold text-white">Create item type</h3>
              <p className="text-[11px] text-zinc-400">
                Add an item type, then return to the product form.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="cursor-pointer rounded-lg p-1 text-zinc-400 hover:text-white"
            aria-label="Close"
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
            onClick={close}
            className="cursor-pointer rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {isSubmitting ? 'Saving…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
