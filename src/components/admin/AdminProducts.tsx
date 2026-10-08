'use client';

import React, { use, useRef, useState } from 'react';
import {
  Package,
  Plus,
  Search,
  Filter,
  Edit2,
  Trash2,
  Check,
  X,
  Download,
  Layers,
  Tag,
  DollarSign,
  AlertTriangle,
  Eye,
  ArrowUpDown,
  Copy,
  Upload,
} from 'lucide-react';
import { type Product, type Category } from '@/types/index';
import { AppImage, PRODUCT_IMAGE_FALLBACK } from '@/components/ui/AppImage';
import { buildProductsCsv } from '@/lib/productCsv';
import { downloadCsv } from '@/lib/downloadPdf';
import Link from 'next/link';
import { ProductImportDialog } from '@/components/admin/ProductImportDialog';
import { setProductsActiveAction } from '@/server/domains/catalog/actions';
import { ProductDeleteDialog } from '@/components/admin/ProductDeleteDialog';
import {
  BusyOverlay,
  ResultNotice,
  useWarnBeforeLeaving,
  type BulkNotice,
} from '@/components/admin/BulkFeedback';
import type { ProductSelection } from '@/server/domains/catalog/bulk-delete';

interface AdminProductsProps {
  productsPromise: Promise<Product[]>;
  categoriesPromise: Promise<Category[]>;
  onOpenCreateProduct: () => void;
  onEditProduct: (product: Product) => void;
  onDuplicateProduct: (product: Product) => void;
  onRefresh: () => void;
  /** What the person may do; the server checks again. Defaults suit callers that do not know. */
  canDelete?: boolean;
  canPurge?: boolean;
  /** Products in the trash, shown on the link to it. */
  trashCount?: number;
}

export function AdminProducts({
  productsPromise,
  categoriesPromise,
  onOpenCreateProduct,
  onEditProduct,
  onDuplicateProduct,
  onRefresh,
  canDelete = true,
  canPurge = false,
  trashCount,
}: AdminProductsProps) {
  const products = use(productsPromise);
  const categories = use(categoriesPromise);

  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'draft'>('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'low_stock' | 'out_of_stock'>(
    'all',
  );
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  /** "Select all in the catalogue": every product, including ones the filters hide, minus `excluded`. */
  const [allInCatalog, setAllInCatalog] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<{
    selection: ProductSelection;
    count: number;
    label: string;
  } | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  /** Set while a bulk change runs: the screen is blocked and says what is happening. */
  const [working, setWorking] = useState<string | null>(null);
  const workingRef = useRef(false);
  const [notice, setNotice] = useState<BulkNotice | null>(null);

  useWarnBeforeLeaving(working !== null);

  // Filtering Logic
  const filteredProducts = products.filter((p) => {
    const available = p.stockQuantity - p.reservedQuantity;
    const matchesSearch =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.sku.toLowerCase().includes(search.toLowerCase()) ||
      p.stockCode.toLowerCase().includes(search.toLowerCase()) ||
      p.category.toLowerCase().includes(search.toLowerCase());

    const matchesCategory =
      selectedCategory === 'all' || p.category.toLowerCase() === selectedCategory.toLowerCase();
    const matchesStatus =
      statusFilter === 'all' || (statusFilter === 'active' ? p.isActive : !p.isActive);

    let matchesStock = true;
    if (stockFilter === 'in_stock') matchesStock = available > p.lowStockThreshold;
    else if (stockFilter === 'low_stock')
      matchesStock = available > 0 && available <= p.lowStockThreshold;
    else if (stockFilter === 'out_of_stock') matchesStock = available <= 0;

    return matchesSearch && matchesCategory && matchesStatus && matchesStock;
  });

  const isSelected = (id: string) =>
    allInCatalog ? !excluded.has(id) : selectedProductIds.has(id);
  const selectionCount = allInCatalog ? products.length - excluded.size : selectedProductIds.size;
  const selectedInView = filteredProducts.filter((p) => isSelected(p.id)).length;
  const clearSelection = () => {
    setSelectedProductIds(new Set());
    setAllInCatalog(false);
    setExcluded(new Set());
  };

  // Header checkbox: everything in view, or nothing.
  const handleSelectAll = (checked: boolean) => {
    if (!checked) return clearSelection();
    if (allInCatalog) {
      const next = new Set(excluded);
      for (const p of filteredProducts) next.delete(p.id);
      setExcluded(next);
    } else {
      setSelectedProductIds(new Set([...selectedProductIds, ...filteredProducts.map((p) => p.id)]));
    }
  };

  const handleToggleSelectOne = (id: string) => {
    const set = allInCatalog ? new Set(excluded) : new Set(selectedProductIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    if (allInCatalog) setExcluded(set);
    else setSelectedProductIds(set);
  };

  // Deleting always goes through the confirmation dialog.
  const askDeleteSelected = () => {
    if (selectionCount === 0) return;
    setDeleting({
      selection: allInCatalog
        ? { mode: 'all', excludeIds: [...excluded] }
        : { mode: 'ids', ids: [...selectedProductIds] },
      count: selectionCount,
      label: `${selectionCount.toLocaleString('en-KE')} product${selectionCount === 1 ? '' : 's'}`,
    });
  };

  /** Publishes or hides products on the server in one request, with the screen blocked meanwhile. */
  const runStatusChange = async (selection: ProductSelection, count: number, active: boolean) => {
    if (workingRef.current || count === 0) return;
    workingRef.current = true;
    setNotice(null);
    const what = `${count.toLocaleString('en-KE')} product${count === 1 ? '' : 's'}`;
    setWorking(`${active ? 'Publishing' : 'Hiding'} ${what}…`);
    const r = await setProductsActiveAction(selection, active, count);
    workingRef.current = false;
    setWorking(null);
    if (!r.ok) {
      setNotice({ tone: 'error', text: r.error, details: [] });
      return;
    }
    const d = r.data;
    const state = active ? 'Active' : 'Draft';
    const parts = [
      d.changed > 0
        ? `${d.changed.toLocaleString('en-KE')} product${d.changed === 1 ? '' : 's'} marked ${state}.`
        : `Nothing changed.`,
      d.unchanged > 0 ? `${d.unchanged.toLocaleString('en-KE')} already ${state}.` : '',
      d.skipped > 0 ? `${d.skipped.toLocaleString('en-KE')} left as they were.` : '',
    ].filter(Boolean);
    setNotice({
      tone: d.skipped > 0 ? 'warn' : 'ok',
      text: parts.join(' '),
      details: [
        ...d.skippedSample.map((x) => `${x.name} (${x.sku}): ${x.reason}`),
        ...(d.skipped > d.skippedSample.length
          ? [`…and ${(d.skipped - d.skippedSample.length).toLocaleString('en-KE')} more.`]
          : []),
      ],
    });
    clearSelection();
    onRefresh();
  };

  const currentSelection = (): ProductSelection =>
    allInCatalog
      ? { mode: 'all', excludeIds: [...excluded] }
      : { mode: 'ids', ids: [...selectedProductIds] };

  const handleBulkStatusChange = (active: boolean) =>
    runStatusChange(currentSelection(), selectionCount, active);

  const handleDeleteSingle = (p: Product) =>
    setDeleting({
      selection: { mode: 'ids', ids: [p.id] },
      count: 1,
      label: `"${p.name}" (${p.sku})`,
    });

  // Toggle single product status
  const handleToggleStatus = (p: Product) =>
    runStatusChange({ mode: 'ids', ids: [p.id] }, 1, !p.isActive);

  // Export the filtered list with every importable column (same contract as the import).
  const handleExportCSV = () => {
    downloadCsv(
      buildProductsCsv(filteredProducts),
      `products_${new Date().toISOString().slice(0, 10)}.csv`,
    );
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-fg-strong">
            <Package className="h-5 w-5 text-indigo-400" />
            Product Catalog Master
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Manage SKU specifications, multi-tier pricing, product margins, active status, and
            catalog metadata.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-3">
          <button
            type="button"
            onClick={handleExportCSV}
            className="flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover hover:text-fg-strong"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export CSV
          </button>

          {canDelete ? (
            <Link
              href="/admin/trash/products"
              className="flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover hover:text-fg-strong"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Trash
              {trashCount !== undefined && trashCount > 0
                ? ` (${trashCount.toLocaleString('en-KE')})`
                : ''}
            </Link>
          ) : null}

          <button
            type="button"
            onClick={() => setIsImportOpen(true)}
            className="flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover hover:text-fg-strong"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Import CSV
          </button>

          <button
            type="button"
            onClick={onOpenCreateProduct}
            className="col-span-2 flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" />
            Add New Product
          </button>
        </div>
      </div>

      <ProductImportDialog
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onImported={onRefresh}
      />

      {working !== null ? <BusyOverlay text={working} /> : null}

      {notice ? <ResultNotice notice={notice} onDismiss={() => setNotice(null)} /> : null}

      {deleting ? (
        <ProductDeleteDialog
          selection={deleting.selection}
          count={deleting.count}
          label={deleting.label}
          canPurge={canPurge}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            clearSelection();
            onRefresh();
          }}
        />
      ) : null}

      {/* Filter and Search Bar */}
      <div className="space-y-3 rounded-xl border border-line bg-surface-raised p-4 text-xs">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          {/* Search Input */}
          <div className="relative sm:col-span-1">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              type="text"
              placeholder="Search by SKU, title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface py-1.5 pr-4 pl-9 text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {/* Category Filter */}
          <div>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong focus:border-indigo-500 focus:outline-none"
            >
              <option value="all">All Categories ({categories.length})</option>
              {categories.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Stock Level Filter */}
          <div>
            <select
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value as any)}
              className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong focus:border-indigo-500 focus:outline-none"
            >
              <option value="all">All Stock Levels</option>
              <option value="in_stock">In Stock (&gt; Low Threshold)</option>
              <option value="low_stock">Low Stock Alerts</option>
              <option value="out_of_stock">Out of Stock (0 On Hand)</option>
            </select>
          </div>

          {/* Status Filter */}
          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong focus:border-indigo-500 focus:outline-none"
            >
              <option value="all">All Publishing Statuses</option>
              <option value="active">Active Storefront Items</option>
              <option value="draft">Draft / Hidden Items</option>
            </select>
          </div>
        </div>

        {/* Bulk Action Ribbon when items selected */}
        {selectionCount > 0 && (
          <div
            className="space-y-2 rounded-lg border border-indigo-600 bg-indigo-50 p-2.5 text-indigo-600 dark:text-indigo-400"
            role="region"
            aria-label="Selected products"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold" role="status">
                {allInCatalog && excluded.size === 0
                  ? `All ${selectionCount.toLocaleString('en-KE')} products in the catalogue selected`
                  : `${selectionCount.toLocaleString('en-KE')} product${selectionCount > 1 ? 's' : ''} selected`}
              </span>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={working !== null}
                  onClick={() => handleBulkStatusChange(true)}
                  className="min-h-9 cursor-pointer rounded border border-line-strong bg-surface-raised px-2.5 py-1 font-medium text-fg-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Mark Active
                </button>
                <button
                  type="button"
                  disabled={working !== null}
                  onClick={() => handleBulkStatusChange(false)}
                  className="min-h-9 cursor-pointer rounded border border-line-strong bg-surface-raised px-2.5 py-1 font-medium text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Mark Draft
                </button>
                {canDelete ? (
                  <button
                    type="button"
                    disabled={working !== null}
                    onClick={askDeleteSelected}
                    className="min-h-9 cursor-pointer rounded bg-red-600 px-2.5 py-1 font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Delete Selected
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={clearSelection}
                  className="min-h-9 cursor-pointer rounded px-2.5 py-1 font-medium underline hover:no-underline"
                >
                  Clear
                </button>
              </div>
            </div>
            {!allInCatalog && products.length > selectionCount ? (
              <p className="text-fg">
                {selectedInView === filteredProducts.length && filteredProducts.length > 0
                  ? filteredProducts.length < products.length
                    ? `Everything matching the filters is selected. `
                    : `Everything on this page is selected. `
                  : ''}
                <button
                  type="button"
                  onClick={() => {
                    setAllInCatalog(true);
                    setExcluded(new Set());
                  }}
                  className="min-h-9 cursor-pointer font-semibold text-indigo-700 underline hover:no-underline"
                >
                  Select all {products.length.toLocaleString('en-KE')} products in the catalogue
                </button>
                {filteredProducts.length < products.length
                  ? ' (including ones the filters hide)'
                  : ''}
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* Products Data Table */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
              <tr>
                <th className="w-8 px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all products in view"
                    checked={
                      filteredProducts.length > 0 && selectedInView === filteredProducts.length
                    }
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          selectedInView > 0 && selectedInView < filteredProducts.length;
                    }}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="cursor-pointer rounded border-line-strong bg-surface text-indigo-600 focus:ring-0"
                  />
                </th>
                <th className="px-4 py-3">Product / SKU / Stock Code</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Price (KES)</th>
                <th className="px-4 py-3 text-right">Cost / Margin</th>
                <th className="px-4 py-3 text-center">Available Stock</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-fg">
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-fg-subtle">
                    No products found matching the specified filters.
                  </td>
                </tr>
              ) : (
                filteredProducts.map((p) => {
                  const available = p.stockQuantity - p.reservedQuantity;
                  const isLow = available <= p.lowStockThreshold && available > 0;
                  const isOut = available <= 0;
                  const rowSelected = isSelected(p.id);
                  const cost = p.costPrice;
                  const sellPrice = p.price;
                  const marginPct =
                    sellPrice != null && sellPrice > 0 && cost != null
                      ? (((sellPrice - cost) / sellPrice) * 100).toFixed(0)
                      : null;

                  return (
                    <tr
                      key={p.id}
                      className={`transition-colors hover:bg-hover ${rowSelected ? 'bg-indigo-50' : ''}`}
                    >
                      <td className="px-3 py-3.5">
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.name}`}
                          checked={rowSelected}
                          onChange={() => handleToggleSelectOne(p.id)}
                          className="cursor-pointer rounded border-line-strong bg-surface text-indigo-600 focus:ring-0"
                        />
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-3">
                          <AppImage
                            src={p.imageUrl}
                            alt={p.name}
                            width={40}
                            height={40}
                            sizes="40px"
                            fallbackSrc={PRODUCT_IMAGE_FALLBACK}
                            className="h-10 w-10 shrink-0 rounded-lg border border-line bg-surface object-cover"
                            referrerPolicy="no-referrer"
                          />
                          <div>
                            <div
                              className="cursor-pointer font-semibold text-fg-strong transition-colors hover:text-indigo-400"
                              onClick={() => onEditProduct(p)}
                            >
                              {p.name}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-fg-muted">
                              <span>SKU: {p.sku}</span>
                              <span className="text-fg-subtle">Stock: {p.stockCode}</span>
                              {p.brand && (
                                <span className="font-sans text-fg-subtle">• {p.brand}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="rounded-md border border-line bg-surface px-2 py-0.5 font-medium text-fg">
                          {p.category}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono font-semibold text-fg-strong">
                        {sellPrice != null ? (
                          <>
                            KES {sellPrice.toLocaleString()}
                            {p.compareAtPrice != null && p.compareAtPrice > sellPrice && (
                              <div className="text-[10px] text-fg-subtle line-through">
                                KES {p.compareAtPrice.toLocaleString()}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-[11px]">
                        {cost != null ? (
                          <>
                            <span className="block text-fg-muted">KES {cost.toLocaleString()}</span>
                            {marginPct != null ? (
                              <span
                                className={`font-semibold ${Number(marginPct) >= 20 ? 'text-emerald-600' : 'text-amber-600'}`}
                              >
                                {marginPct}% margin
                              </span>
                            ) : (
                              <span className="text-fg-subtle">No margin</span>
                            )}
                          </>
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <div className="inline-flex flex-col items-center">
                          <span
                            className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ${
                              isOut
                                ? 'border border-red-800 bg-red-50 text-red-600'
                                : isLow
                                  ? 'border border-amber-800 bg-amber-50 text-amber-700'
                                  : 'bg-surface-sunken text-fg-strong'
                            }`}
                          >
                            {available} available
                          </span>
                          {p.reservedQuantity > 0 && (
                            <span className="mt-0.5 font-mono text-[10px] text-fg-subtle">
                              ({p.reservedQuantity} reserved)
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <button
                          type="button"
                          disabled={working !== null}
                          aria-label={`${p.name}: ${p.isActive ? 'Active' : 'Draft'}. Change`}
                          onClick={() => handleToggleStatus(p)}
                          className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                            p.isActive
                              ? 'border border-emerald-800 bg-emerald-50/80 text-emerald-700'
                              : 'border border-line-strong bg-surface-sunken text-fg-muted'
                          }`}
                        >
                          {p.isActive ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          {p.isActive ? 'Active' : 'Draft'}
                        </button>
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => onEditProduct(p)}
                            className="cursor-pointer rounded-lg bg-surface-sunken p-1.5 text-fg transition-colors hover:bg-hover hover:text-fg-strong"
                            title="Edit Product"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDuplicateProduct(p)}
                            className="cursor-pointer rounded-lg bg-surface-sunken p-1.5 text-fg transition-colors hover:bg-indigo-50 hover:text-indigo-700"
                            title="Duplicate Product"
                            aria-label={`Duplicate ${p.name}`}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          {canDelete ? (
                            <button
                              type="button"
                              onClick={() => handleDeleteSingle(p)}
                              className="cursor-pointer rounded-lg bg-surface-sunken p-1.5 text-fg transition-colors hover:bg-red-100 hover:text-red-700"
                              title="Delete Product"
                              aria-label={`Delete ${p.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
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
    </div>
  );
}
