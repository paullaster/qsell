'use client';

import React, { use, useState } from 'react';
import {
  FolderTree,
  Plus,
  Search,
  Edit2,
  Trash2,
  Check,
  X,
  Package,
  Layers,
  ArrowUpDown,
  Tag,
} from 'lucide-react';
import { type Category, type Product } from '@/types/index';
import { createCategoryAction, updateCategoryAction, deleteCategoryAction } from '@/server/actions';

interface AdminCategoriesProps {
  categoriesPromise: Promise<Category[]>;
  productsPromise: Promise<Product[]>;
  onRefresh: () => void;
}

export function AdminCategories({
  categoriesPromise,
  productsPromise,
  onRefresh,
}: AdminCategoriesProps) {
  const categories = use(categoriesPromise);
  const products = use(productsPromise);

  const [search, setSearch] = useState('');
  const [filterActiveOnly, setFilterActiveOnly] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [categoryToEdit, setCategoryToEdit] = useState<Category | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [displayOrder, setDisplayOrder] = useState<number>(1);
  const [isActive, setIsActive] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const submitLabel = isSubmitting
    ? 'Saving...'
    : categoryToEdit
      ? 'Save Changes'
      : 'Create Category';

  // Filter Categories
  const filteredCategories = categories.filter((cat) => {
    const matchesSearch =
      cat.name.toLowerCase().includes(search.toLowerCase()) ||
      cat.slug.toLowerCase().includes(search.toLowerCase()) ||
      cat.description.toLowerCase().includes(search.toLowerCase());
    const matchesActive = !filterActiveOnly || cat.isActive;
    return matchesSearch && matchesActive;
  });

  const openCreateModal = () => {
    setCategoryToEdit(null);
    setName('');
    setSlug('');
    setDescription('');
    setDisplayOrder(categories.length + 1);
    setIsActive(true);
    setFormError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (cat: Category) => {
    setCategoryToEdit(cat);
    setName(cat.name);
    setSlug(cat.slug);
    setDescription(cat.description);
    setDisplayOrder(cat.displayOrder);
    setIsActive(cat.isActive);
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Category name is required.');
      return;
    }

    try {
      setIsSubmitting(true);
      setFormError(null);
      const generatedSlug = slug.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      if (categoryToEdit) {
        await updateCategoryAction(categoryToEdit.id, {
          name: name.trim(),
          slug: generatedSlug,
          description: description.trim(),
          displayOrder: Number(displayOrder),
          isActive,
        });
      } else {
        await createCategoryAction({
          name: name.trim(),
          slug: generatedSlug,
          description: description.trim(),
          displayOrder: Number(displayOrder),
          isActive,
        });
      }

      setIsModalOpen(false);
      onRefresh();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save category');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (cat: Category) => {
    const attached = products.filter(
      (p) => p.category.toLowerCase() === cat.name.toLowerCase(),
    );
    const otherCategories = categories
      .filter((c) => c.id !== cat.id)
      .sort(
        (a, b) =>
          Number(b.isActive) - Number(a.isActive) || a.displayOrder - b.displayOrder,
      );
    const fallbackName = otherCategories[0]?.name ?? null;

    let confirmMessage = `Delete category "${cat.name}"?`;
    if (attached.length > 0) {
      confirmMessage = fallbackName
        ? `Delete "${cat.name}"? Its ${attached.length} product${attached.length === 1 ? '' : 's'} will move to "${fallbackName}".`
        : `Delete "${cat.name}"? Its ${attached.length} product${attached.length === 1 ? '' : 's'} will have no category until you assign one.`;
    }

    if (!window.confirm(confirmMessage)) return;

    try {
      await deleteCategoryAction(cat.id);
      onRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleToggleStatus = async (cat: Category) => {
    try {
      await updateCategoryAction(cat.id, { isActive: !cat.isActive });
      onRefresh();
    } catch (err: any) {
      alert(`Status update failed: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-white">
            <FolderTree className="h-5 w-5 text-indigo-400" />
            Category Management
          </h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            Organize catalog taxonomy, URL slugs, storefront hierarchies, and category visibility.
          </p>
        </div>

        <button
          onClick={openCreateModal}
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" />
          Add New Category
        </button>
      </div>

      {/* Filter and Stats Bar */}
      <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-xs sm:flex-row">
        <div className="relative w-full sm:w-80">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search categories by name, slug, description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-1.5 pr-4 pl-9 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:justify-end">
          <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
            <input
              type="checkbox"
              checked={filterActiveOnly}
              onChange={(e) => setFilterActiveOnly(e.target.checked)}
              className="cursor-pointer rounded border-zinc-700 bg-zinc-950 text-indigo-600 focus:ring-0"
            />
            <span>Active Only</span>
          </label>

          <span className="text-zinc-500">
            Total Categories: <strong className="text-white">{categories.length}</strong>
          </span>
        </div>
      </div>

      {/* Category Table */}
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-zinc-800 bg-zinc-950 font-semibold text-zinc-400">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Category Name</th>
                <th className="px-4 py-3">URL Slug</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3 text-center">Products</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 text-zinc-300">
              {filteredCategories.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-zinc-500">
                    No categories match the filter criteria.
                  </td>
                </tr>
              ) : (
                filteredCategories.map((cat) => {
                  const productCount = products.filter(
                    (p) => p.category.toLowerCase() === cat.name.toLowerCase(),
                  ).length;

                  return (
                    <tr key={cat.id} className="transition-colors hover:bg-zinc-800/50">
                      <td className="px-4 py-3.5 font-mono text-zinc-400">#{cat.displayOrder}</td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2 font-semibold text-white">
                          <Tag className="h-3.5 w-3.5 text-indigo-400" />
                          {cat.name}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-zinc-400">/{cat.slug}</td>
                      <td
                        className="max-w-xs truncate px-4 py-3.5 text-zinc-400"
                        title={cat.description}
                      >
                        {cat.description !== '' ? cat.description : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 font-medium text-zinc-300">
                          <Package className="h-3 w-3 text-zinc-400" />
                          {productCount}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <button
                          onClick={() => handleToggleStatus(cat)}
                          className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${
                            cat.isActive
                              ? 'border border-emerald-800 bg-emerald-950/80 text-emerald-300'
                              : 'border border-zinc-700 bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {cat.isActive ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          {cat.isActive ? 'Active' : 'Disabled'}
                        </button>
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => openEditModal(cat)}
                            className="cursor-pointer rounded-lg bg-zinc-800 p-1.5 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
                            title="Edit Category"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(cat)}
                            className="cursor-pointer rounded-lg bg-zinc-800 p-1.5 text-zinc-300 transition-colors hover:bg-red-900/60 hover:text-red-300"
                            title="Delete Category"
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

      {/* Add / Edit Category Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm">
          <div className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 p-5">
              <div className="flex items-center gap-2">
                <FolderTree className="h-5 w-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">
                  {categoryToEdit ? 'Edit Category' : 'Create Category'}
                </h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-zinc-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 p-6">
              {formError != null && formError !== '' && (
                <div className="rounded-lg border border-red-800 bg-red-950/80 p-3 text-xs text-red-200">
                  {formError}
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-300">
                  Category Name *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!categoryToEdit) {
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
                    }
                  }}
                  required
                  placeholder="e.g. Smart Home & IoT"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-300">URL Slug</label>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="e.g. smart-home-iot"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 font-mono text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-300">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Brief description of products within this category..."
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-300">
                    Display Order
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={displayOrder}
                    onChange={(e) => setDisplayOrder(Number(e.target.value))}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 font-mono text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-300">
                    Storefront Status
                  </label>
                  <select
                    value={isActive ? 'active' : 'inactive'}
                    onChange={(e) => setIsActive(e.target.value === 'active')}
                    className="w-full cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="active">Active (Visible in Store)</option>
                    <option value="inactive">Disabled (Hidden)</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-zinc-800 pt-4">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="cursor-pointer rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 disabled:opacity-50"
                >
                  {submitLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
