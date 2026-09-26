'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderTree, X } from 'lucide-react';
import { createCategoryAction } from '@/server/actions';
import { publishCatalogShortcut } from '@/components/admin/catalog-shortcuts';

export function CategoryCreateModal({ presentation }: { presentation: 'intercepted' | 'page' }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [displayOrder, setDisplayOrder] = useState('1');
  const [isActive, setIsActive] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push('/admin/categories');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Category name is required.');
      return;
    }

    const parsedOrder = Number(displayOrder);
    if (!Number.isFinite(parsedOrder) || parsedOrder < 1) {
      setFormError('Display order must be 1 or greater.');
      return;
    }

    try {
      setIsSubmitting(true);
      setFormError(null);
      const category = await createCategoryAction({
        name: name.trim(),
        slug: slug.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        description: description.trim(),
        displayOrder: parsedOrder,
        isActive,
      });

      if (presentation === 'intercepted') {
        publishCatalogShortcut({ kind: 'category', category });
        router.back();
      } else {
        router.push('/admin/categories');
        router.refresh();
      }
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save category');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-sm">
      <div className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
        <div className="flex items-center justify-between border-b border-line bg-surface p-5">
          <div className="flex items-center gap-2">
            <FolderTree className="h-5 w-5 text-indigo-400" />
            <div>
              <h3 className="text-base font-bold text-fg-strong">Create Category</h3>
              <p className="text-[11px] text-fg-muted">
                Add a category, then return to the product form.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="cursor-pointer rounded-lg p-1 text-fg-muted hover:text-fg-strong"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {formError ? (
            <div className="rounded-lg border border-red-800 bg-red-50/80 p-3 text-xs text-red-800">
              {formError}
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-xs font-semibold text-fg">Category Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
              }}
              required
              placeholder="e.g. Smart Home & IoT"
              className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-fg">URL Slug</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="e.g. smart-home-iot"
              className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-fg">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Brief description of products within this category..."
              className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-fg">Display Order</label>
              <input
                type="number"
                min={1}
                value={displayOrder}
                onChange={(e) => setDisplayOrder(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-fg">Storefront Status</label>
              <select
                value={isActive ? 'active' : 'inactive'}
                onChange={(e) => setIsActive(e.target.value === 'active')}
                className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
              >
                <option value="active">Active (Visible in Store)</option>
                <option value="inactive">Disabled (Hidden)</option>
              </select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
            <button
              type="button"
              onClick={close}
              className="cursor-pointer rounded-lg bg-surface-sunken px-4 py-2 text-xs font-medium text-fg hover:bg-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving...' : 'Create Category'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
