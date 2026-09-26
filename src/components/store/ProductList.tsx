'use client';

import React, { use, useState, useMemo } from 'react';
import { type Product } from '@/types/index';
import { ProductCard } from './ProductCard';
import { Package } from 'lucide-react';
import { productGridClassName } from '@/config/company-ui';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';
import { productDescriptionPlainText } from '@/lib/productDescription';

interface ProductListProps {
  productsPromise: Promise<Product[]>;
  onAddToCart: (product: Product) => void;
  onQuickView?: (product: Product) => void;
  onSelectProduct?: (product: Product) => void;
  onQuickBuy?: (product: Product) => void;
  selectedCategory?: string;
  onSelectCategory?: (category: string) => void;
  searchQuery?: string;
}

export function ProductList({
  productsPromise,
  onAddToCart,
  onQuickView,
  onSelectProduct,
  onQuickBuy,
  selectedCategory: externalSelectedCategory,
  onSelectCategory,
  searchQuery: externalSearchQuery = '',
}: ProductListProps) {
  const products = use(productsPromise);
  const { productGrid } = useCompanyUiConfig();
  const gridClassName = productGridClassName(productGrid.desktopColumns);

  const [internalCategory, setInternalCategory] = useState<string>('All');
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'low_stock'>('all');
  const [sortBy, setSortBy] = useState<'featured' | 'price_asc' | 'price_desc' | 'rating'>(
    'featured',
  );

  // Controlled when parent passes selectedCategory (incl. "All"); never use || with "All".
  const selectedCategory =
    externalSelectedCategory !== undefined ? externalSelectedCategory : internalCategory;
  const searchQuery = externalSearchQuery;

  const setCategory = (cat: string) => {
    if (onSelectCategory) onSelectCategory(cat);
    else setInternalCategory(cat);
  };

  const handleInspect = (product: Product) => {
    if (onSelectProduct) onSelectProduct(product);
    else if (onQuickView) onQuickView(product);
  };

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean));
    return ['All', ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [products]);

  const filteredProducts = useMemo(() => {
    return products
      .filter((p) => {
        const matchesCat =
          selectedCategory === 'All' || p.category.toLowerCase() === selectedCategory.toLowerCase();
        const matchesSearch =
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          productDescriptionPlainText(p.description)
            .toLowerCase()
            .includes(searchQuery.toLowerCase()) ||
          p.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));

        const available = p.stockQuantity - p.reservedQuantity;
        let matchesStock = true;
        if (stockFilter === 'in_stock') matchesStock = available > 0;
        if (stockFilter === 'low_stock')
          matchesStock = available > 0 && available <= p.lowStockThreshold;

        return matchesCat && matchesSearch && matchesStock;
      })
      .sort((a, b) => {
        if (sortBy === 'price_asc') return (a.price ?? 0) - (b.price ?? 0);
        if (sortBy === 'price_desc') return (b.price ?? 0) - (a.price ?? 0);
        if (sortBy === 'rating') return b.rating - a.rating;
        return 0;
      });
  }, [products, selectedCategory, searchQuery, stockFilter, sortBy]);

  const categoryButtonClass = (cat: string, layout: 'rail' | 'pill') => {
    const active = selectedCategory === cat;
    const base =
      layout === 'rail'
        ? 'w-full cursor-pointer rounded-lg px-3 py-2 text-left text-xs font-medium transition-all'
        : 'cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-all';
    return `${base} ${
      active
        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
        : 'border border-line bg-surface text-fg-muted hover:bg-hover hover:text-fg-strong'
    }`;
  };

  const categoryNav = (layout: 'rail' | 'pill') => (
    <nav
      aria-label="Product categories"
      className={
        layout === 'rail'
          ? 'flex flex-col gap-1.5'
          : 'flex scrollbar-none items-center gap-2 overflow-x-auto pb-1'
      }
    >
      {categories.map((cat) => (
        <button
          key={cat}
          type="button"
          onClick={() => setCategory(cat)}
          className={categoryButtonClass(cat, layout)}
        >
          {cat}
        </button>
      ))}
    </nav>
  );

  const filtersBar = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center rounded-lg border border-line bg-surface p-1 text-xs">
        <button
          type="button"
          onClick={() => setStockFilter('all')}
          className={`cursor-pointer rounded-md px-2.5 py-1 transition-colors ${
            stockFilter === 'all'
              ? 'bg-surface-sunken font-semibold text-fg-strong'
              : 'text-fg-muted hover:text-fg-strong'
          }`}
        >
          All Items ({products.length})
        </button>
        <button
          type="button"
          onClick={() => setStockFilter('in_stock')}
          className={`cursor-pointer rounded-md px-2.5 py-1 transition-colors ${
            stockFilter === 'in_stock'
              ? 'bg-indigo-600 text-white font-semibold shadow-sm'
              : 'text-fg-muted hover:text-fg-strong'
          }`}
        >
          In Stock
        </button>
        <button
          type="button"
          onClick={() => setStockFilter('low_stock')}
          className={`cursor-pointer rounded-md px-2.5 py-1 transition-colors ${
            stockFilter === 'low_stock'
              ? 'bg-amber-600 text-white font-semibold shadow-sm'
              : 'text-fg-muted hover:text-fg-strong'
          }`}
        >
          Low Stock
        </button>
      </div>

      <select
        value={sortBy}
        onChange={(e) =>
          setSortBy(e.target.value as 'featured' | 'price_asc' | 'price_desc' | 'rating')
        }
        className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
      >
        <option value="featured">Sort: Featured First</option>
        <option value="price_asc">Price: Low to High</option>
        <option value="price_desc">Price: High to Low</option>
        <option value="rating">Highest Rated</option>
      </select>
    </div>
  );

  return (
    <div className="min-[1000px]:flex min-[1000px]:items-start min-[1000px]:gap-6">
      {/* Vertical category rail — far left from 1000px up */}
      <aside className="sticky top-20 hidden w-48 shrink-0 min-[1000px]:block lg:w-52">
        <div className="rounded-xl border border-line bg-surface-raised p-3">
          <p className="mb-2 px-1 text-[10px] font-semibold tracking-wider text-fg-subtle uppercase">
            Categories
          </p>
          {categoryNav('rail')}
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-6">
        {/* Mobile / tablet: horizontal categories + filters */}
        <div className="space-y-3 rounded-xl border border-line bg-surface-raised p-4 min-[1000px]:space-y-0">
          <div className="min-[1000px]:hidden">{categoryNav('pill')}</div>
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            {filtersBar}
          </div>
        </div>

        {filteredProducts.length > 0 ? (
          <div className={gridClassName}>
            {filteredProducts.map((product, index) => (
              <ProductCard
                key={product.id}
                product={product}
                preloadImage={index === 0}
                onAddToCart={onAddToCart}
                onQuickView={handleInspect}
                onQuickBuy={onQuickBuy}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-3 rounded-xl border border-line bg-surface-raised p-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-surface-sunken text-fg-muted">
              <Package className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-fg-strong">No products found</h3>
            <p className="mx-auto max-w-sm text-xs text-fg-muted">
              We couldn&apos;t find any products matching your search criteria or category filter.
              Try clearing filters or searching for another keyword.
            </p>
            <button
              type="button"
              onClick={() => {
                setCategory('All');
                setStockFilter('all');
              }}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
            >
              Reset Filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
