'use client';

import React, { use, useState, useMemo } from 'react';
import { Product } from '@/types/index';
import { ProductCard } from './ProductCard';
import { Filter, SlidersHorizontal, Package, Sparkles } from 'lucide-react';

interface ProductListProps {
  productsPromise: Promise<Product[]>;
  onAddToCart: (product: Product) => void;
  onQuickView?: (product: Product) => void;
  onSelectProduct?: (product: Product) => void;
  onQuickBuy?: (product: Product) => void;
  selectedCategory?: string;
  searchQuery?: string;
}

export function ProductList({
  productsPromise,
  onAddToCart,
  onQuickView,
  onSelectProduct,
  onQuickBuy,
  selectedCategory: externalSelectedCategory,
  searchQuery: externalSearchQuery = ''
}: ProductListProps) {
  // React 19 `use` hook resolves the promise passed from the server action / parent
  const products = use(productsPromise);

  const [internalCategory, setInternalCategory] = useState<string>('All');
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'low_stock'>('all');
  const [sortBy, setSortBy] = useState<'featured' | 'price_asc' | 'price_desc' | 'rating'>('featured');

  const selectedCategory = externalSelectedCategory || internalCategory;
  const searchQuery = externalSearchQuery;

  const handleInspect = (product: Product) => {
    if (onSelectProduct) onSelectProduct(product);
    else if (onQuickView) onQuickView(product);
  };

  // Extract unique categories
  const categories = useMemo(() => {
    const set = new Set(products.map(p => p.category));
    return ['All', ...Array.from(set)];
  }, [products]);

  // Filtered & Sorted Products
  const filteredProducts = useMemo(() => {
    return products
      .filter(p => {
        const matchesCat = selectedCategory === 'All' || p.category === selectedCategory;
        const matchesSearch = 
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));

        const available = p.stockQuantity - p.reservedQuantity;
        let matchesStock = true;
        if (stockFilter === 'in_stock') matchesStock = available > 0;
        if (stockFilter === 'low_stock') matchesStock = available > 0 && available <= p.lowStockThreshold;

        return matchesCat && matchesSearch && matchesStock;
      })
      .sort((a, b) => {
        if (sortBy === 'price_asc') return a.price - b.price;
        if (sortBy === 'price_desc') return b.price - a.price;
        if (sortBy === 'rating') return b.rating - a.rating;
        return 0; // featured default
      });
  }, [products, selectedCategory, searchQuery, stockFilter, sortBy]);

  return (
    <div className="space-y-6">
      {/* Category Pills & Filters Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
        {/* Categories */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 lg:pb-0 scrollbar-none">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setInternalCategory(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                selectedCategory === cat
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                  : 'bg-zinc-950 text-zinc-400 hover:text-white hover:bg-zinc-800 border border-zinc-800'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Filter controls */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Stock filter */}
          <div className="flex items-center bg-zinc-950 rounded-lg p-1 border border-zinc-800 text-xs">
            <button
              onClick={() => setStockFilter('all')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                stockFilter === 'all' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              All Items ({products.length})
            </button>
            <button
              onClick={() => setStockFilter('in_stock')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                stockFilter === 'in_stock' ? 'bg-indigo-600 text-white font-semibold shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              In Stock
            </button>
            <button
              onClick={() => setStockFilter('low_stock')}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                stockFilter === 'low_stock' ? 'bg-amber-600 text-white font-semibold shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Low Stock
            </button>
          </div>

          {/* Sort selection */}
          <select
            value={sortBy}
            onChange={(e: any) => setSortBy(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 text-zinc-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="featured">Sort: Featured First</option>
            <option value="price_asc">Price: Low to High</option>
            <option value="price_desc">Price: High to Low</option>
            <option value="rating">Highest Rated</option>
          </select>
        </div>
      </div>

      {/* Products Grid */}
      {filteredProducts.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {filteredProducts.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onAddToCart={onAddToCart}
              onQuickView={handleInspect}
              onQuickBuy={onQuickBuy}
            />
          ))}
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-zinc-800 flex items-center justify-center mx-auto text-zinc-400">
            <Package className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-white">No products found</h3>
          <p className="text-xs text-zinc-400 max-w-sm mx-auto">
            We couldn't find any products matching your search criteria or category filter. Try clearing filters or searching for another keyword.
          </p>
          <button
            onClick={() => {
              setInternalCategory('All');
              setStockFilter('all');
            }}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-500 shadow-lg shadow-indigo-600/20 transition-colors"
          >
            Reset Filters
          </button>
        </div>
      )}
    </div>
  );
}
