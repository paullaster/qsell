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
  ArrowUpDown
} from 'lucide-react';
import { Product, Category } from '../../types/index.js';
import { 
  deleteProductAction, 
  updateProductAction 
} from '../../lib/serverActions.js';

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
  onRefresh
}: AdminProductsProps) {
  const products = use(productsPromise);
  const categories = use(categoriesPromise);

  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'draft'>('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'low_stock' | 'out_of_stock'>('all');
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());

  // Filtering Logic
  const filteredProducts = products.filter((p) => {
    const available = p.stockQuantity - p.reservedQuantity;
    const matchesSearch =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.sku.toLowerCase().includes(search.toLowerCase()) ||
      p.category.toLowerCase().includes(search.toLowerCase());

    const matchesCategory = selectedCategory === 'all' || p.category.toLowerCase() === selectedCategory.toLowerCase();
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' ? p.isActive : !p.isActive);
    
    let matchesStock = true;
    if (stockFilter === 'in_stock') matchesStock = available > p.lowStockThreshold;
    else if (stockFilter === 'low_stock') matchesStock = available > 0 && available <= p.lowStockThreshold;
    else if (stockFilter === 'out_of_stock') matchesStock = available <= 0;

    return matchesSearch && matchesCategory && matchesStatus && matchesStock;
  });

  // Select all checkbox
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedProductIds(new Set(filteredProducts.map(p => p.id)));
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
    if (window.confirm(`Are you sure you want to permanently delete ${selectedProductIds.size} selected products?`)) {
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
    const headers = ['SKU', 'Name', 'Category', 'Price_KES', 'Cost_KES', 'Stock_Qty', 'Reserved_Qty', 'Low_Stock_Threshold', 'Status'];
    const rows = filteredProducts.map(p => [
      p.sku,
      `"${p.name.replace(/"/g, '""')}"`,
      p.category,
      p.price,
      p.costPrice || '',
      p.stockQuantity,
      p.reservedQuantity,
      p.lowStockThreshold,
      p.isActive ? 'Active' : 'Draft'
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `omnicommerce_products_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-xl bg-zinc-900 border border-zinc-800">
        <div>
          <h2 className="font-bold text-base text-white flex items-center gap-2">
            <Package className="w-5 h-5 text-indigo-400" />
            Product Catalog Master
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Manage SKU specifications, multi-tier pricing, product margins, active status, and catalog metadata.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold transition-colors cursor-pointer border border-zinc-700"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>

          <button
            onClick={onOpenCreateProduct}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-600/20 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Add New Product
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3 text-xs">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          {/* Search Input */}
          <div className="relative sm:col-span-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              placeholder="Search by SKU, title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-4 py-1.5 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Category Filter */}
          <div>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
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
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
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
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              <option value="all">All Publishing Statuses</option>
              <option value="active">Active Storefront Items</option>
              <option value="draft">Draft / Hidden Items</option>
            </select>
          </div>
        </div>

        {/* Bulk Action Ribbon when items selected */}
        {selectedProductIds.size > 0 && (
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-indigo-950/40 border border-indigo-500/30 text-indigo-200">
            <span className="font-semibold">
              {selectedProductIds.size} product{selectedProductIds.size > 1 ? 's' : ''} selected
            </span>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleBulkStatusChange(true)}
                className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-white font-medium cursor-pointer border border-zinc-700"
              >
                Mark Active
              </button>
              <button
                onClick={() => handleBulkStatusChange(false)}
                className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 font-medium cursor-pointer border border-zinc-700"
              >
                Mark Draft
              </button>
              <button
                onClick={handleBulkDelete}
                className="px-2.5 py-1 rounded bg-red-900 hover:bg-red-800 text-white font-medium cursor-pointer"
              >
                Delete Selected
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Products Data Table */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950 text-zinc-400 font-semibold border-b border-zinc-800">
              <tr>
                <th className="py-3 px-3 w-8">
                  <input
                    type="checkbox"
                    checked={filteredProducts.length > 0 && selectedProductIds.size === filteredProducts.length}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-indigo-600 focus:ring-0 cursor-pointer"
                  />
                </th>
                <th className="py-3 px-4">Product & SKU</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4 text-right">Price (KES)</th>
                <th className="py-3 px-4 text-right">Cost / Margin</th>
                <th className="py-3 px-4 text-center">Available Stock</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 text-zinc-300">
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-zinc-500">
                    No products found matching the specified filters.
                  </td>
                </tr>
              ) : (
                filteredProducts.map((p) => {
                  const available = p.stockQuantity - p.reservedQuantity;
                  const isLow = available <= p.lowStockThreshold && available > 0;
                  const isOut = available <= 0;
                  const isSelected = selectedProductIds.has(p.id);
                  const cost = p.costPrice || Math.round(p.price * 0.75);
                  const marginPct = p.price > 0 ? (((p.price - cost) / p.price) * 100).toFixed(0) : '0';

                  return (
                    <tr key={p.id} className={`hover:bg-zinc-800/40 transition-colors ${isSelected ? 'bg-indigo-950/20' : ''}`}>
                      <td className="py-3.5 px-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleSelectOne(p.id)}
                          className="rounded bg-zinc-950 border-zinc-700 text-indigo-600 focus:ring-0 cursor-pointer"
                        />
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-3">
                          <img
                            src={p.imageUrl}
                            alt={p.name}
                            className="w-10 h-10 rounded-lg object-cover bg-zinc-950 border border-zinc-800 shrink-0"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=100&q=80';
                            }}
                          />
                          <div>
                            <div className="font-semibold text-white hover:text-indigo-400 transition-colors cursor-pointer" onClick={() => onEditProduct(p)}>
                              {p.name}
                            </div>
                            <div className="text-[11px] text-zinc-400 font-mono flex items-center gap-2">
                              <span>{p.sku}</span>
                              {p.brand && <span className="text-zinc-500">• {p.brand}</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="px-2 py-0.5 rounded-md bg-zinc-950 border border-zinc-800 text-zinc-300 font-medium">
                          {p.category}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono font-semibold text-white">
                        KES {p.price.toLocaleString()}
                        {p.compareAtPrice && p.compareAtPrice > p.price && (
                          <div className="text-[10px] text-zinc-500 line-through">
                            KES {p.compareAtPrice.toLocaleString()}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono text-[11px]">
                        <span className="text-zinc-400 block">KES {cost.toLocaleString()}</span>
                        <span className={`font-semibold ${Number(marginPct) >= 20 ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {marginPct}% margin
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <div className="inline-flex flex-col items-center">
                          <span className={`px-2.5 py-0.5 rounded-full font-mono font-bold text-[11px] ${
                            isOut
                              ? 'bg-red-950 text-red-400 border border-red-800'
                              : isLow
                              ? 'bg-amber-950 text-amber-300 border border-amber-800'
                              : 'bg-zinc-800 text-zinc-200'
                          }`}>
                            {available} available
                          </span>
                          {p.reservedQuantity > 0 && (
                            <span className="text-[10px] text-zinc-500 mt-0.5 font-mono">
                              ({p.reservedQuantity} reserved)
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <button
                          onClick={() => handleToggleStatus(p)}
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
                            p.isActive
                              ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                              : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                          }`}
                        >
                          {p.isActive ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                          {p.isActive ? 'Active' : 'Draft'}
                        </button>
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => onEditProduct(p)}
                            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                            title="Edit Product"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteSingle(p)}
                            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-red-900/60 text-zinc-300 hover:text-red-300 transition-colors cursor-pointer"
                            title="Delete Product"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
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
