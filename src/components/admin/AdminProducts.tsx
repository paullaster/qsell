'use client';

import React, { use, useState } from 'react';
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
} from 'lucide-react';
import { type Product, type Category } from '@/types/index';
import { AppImage, PRODUCT_IMAGE_FALLBACK } from '@/components/ui/AppImage';
import { deleteProductAction, updateProductAction } from '@/server/actions';

interface AdminProductsProps {
  productsPromise: Promise<Product[]>;
  categoriesPromise: Promise<Category[]>;
  onOpenCreateProduct: () => void;
  onEditProduct: (product: Product) => void;
  onRefresh: () => void;
}

export function AdminProducts({
  productsPromise,
  categoriesPromise,
  onOpenCreateProduct,
  onEditProduct,
  onRefresh,
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

  // Filtering Logic
  const filteredProducts = products.filter((p) => {
    const available = p.stockQuantity - p.reservedQuantity;
    const matchesSearch =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.sku.toLowerCase().includes(search.toLowerCase()) ||
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

  // Select all checkbox
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedProductIds(new Set(filteredProducts.map((p) => p.id)));
    } else {
      setSelectedProductIds(new Set());
    }
  };

  const handleToggleSelectOne = (id: string) => {
    const next = new Set(selectedProductIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedProductIds(next);
  };

  // Bulk Actions
  const handleBulkDelete = async () => {
    if (selectedProductIds.size === 0) return;
    if (
      window.confirm(
        `Are you sure you want to permanently delete ${selectedProductIds.size} selected products?`,
      )
    ) {
      for (const id of selectedProductIds) {
        await deleteProductAction(id);
      }
      setSelectedProductIds(new Set());
      onRefresh();
    }
  };

  const handleBulkStatusChange = async (active: boolean) => {
    if (selectedProductIds.size === 0) return;
    for (const id of selectedProductIds) {
      await updateProductAction(id, { isActive: active });
    }
    setSelectedProductIds(new Set());
    onRefresh();
  };

  // Single delete
  const handleDeleteSingle = async (p: Product) => {
    if (window.confirm(`Are you sure you want to delete "${p.name}" (${p.sku})?`)) {
      await deleteProductAction(p.id);
      onRefresh();
    }
  };

  // Toggle single product status
  const handleToggleStatus = async (p: Product) => {
    await updateProductAction(p.id, { isActive: !p.isActive });
    onRefresh();
  };

  // Export to CSV
  const handleExportCSV = () => {
    const headers = [
      'SKU',
      'Name',
      'Category',
      'Price_KES',
      'Cost_KES',
      'Stock_Qty',
      'Reserved_Qty',
      'Low_Stock_Threshold',
      'Status',
    ];
    const rows = filteredProducts.map((p) => [
      p.sku,
      `"${p.name.replace(/"/g, '""')}"`,
      p.category,
      p.price ?? '',
      p.costPrice ?? '',
      p.stockQuantity,
      p.reservedQuantity,
      p.lowStockThreshold,
      p.isActive ? 'Active' : 'Draft',
    ]);

    const csvContent = `data:text/csv;charset=utf-8,${[
      headers.join(','),
      ...rows.map((r) => r.join(',')),
    ].join('\n')}`;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute(
      'download',
      `omnicommerce_products_${new Date().toISOString().slice(0, 10)}.csv`,
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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

        <div className="flex items-center gap-3">
          <button
            onClick={handleExportCSV}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover hover:text-fg-strong"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>

          <button
            onClick={onOpenCreateProduct}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" />
            Add New Product
          </button>
        </div>
      </div>

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
        {selectedProductIds.size > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-indigo-600 bg-indigo-50 p-2.5 text-indigo-600 dark:text-indigo-400">
            <span className="font-semibold">
              {selectedProductIds.size} product{selectedProductIds.size > 1 ? 's' : ''} selected
            </span>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleBulkStatusChange(true)}
                className="cursor-pointer rounded border border-line-strong bg-surface-raised px-2.5 py-1 font-medium text-fg-strong hover:bg-hover"
              >
                Mark Active
              </button>
              <button
                onClick={() => handleBulkStatusChange(false)}
                className="cursor-pointer rounded border border-line-strong bg-surface-raised px-2.5 py-1 font-medium text-fg hover:bg-hover"
              >
                Mark Draft
              </button>
              <button
                onClick={handleBulkDelete}
                className="TW cursor-pointer rounded bg-red-100 px-2.5 py-1 font-medium hover:bg-red-100"
              >
                Delete Selected
              </button>
            </div>
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
                    checked={
                      filteredProducts.length > 0 &&
                      selectedProductIds.size === filteredProducts.length
                    }
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="cursor-pointer rounded border-line-strong bg-surface text-indigo-600 focus:ring-0"
                  />
                </th>
                <th className="px-4 py-3">Product & SKU</th>
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
                  const isSelected = selectedProductIds.has(p.id);
                  const cost = p.costPrice;
                  const sellPrice = p.price;
                  const marginPct =
                    sellPrice != null && sellPrice > 0 && cost != null
                      ? (((sellPrice - cost) / sellPrice) * 100).toFixed(0)
                      : null;

                  return (
                    <tr
                      key={p.id}
                      className={`transition-colors hover:bg-hover ${isSelected ? 'bg-indigo-50' : ''}`}
                    >
                      <td className="px-3 py-3.5">
                        <input
                          type="checkbox"
                          checked={isSelected}
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
                            <div className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
                              <span>{p.sku}</span>
                              {p.brand && <span className="text-fg-subtle">• {p.brand}</span>}
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
                          onClick={() => handleToggleStatus(p)}
                          className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${
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
                            onClick={() => handleDeleteSingle(p)}
                            className="cursor-pointer rounded-lg bg-surface-sunken p-1.5 text-fg transition-colors hover:bg-red-100 hover:text-red-700"
                            title="Delete Product"
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
    </div>
  );
}
