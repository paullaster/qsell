'use client';

import React from 'react';
import { ShoppingCart, Eye, Star, Zap, ShieldCheck, Check } from 'lucide-react';
import { type Product } from '@/types/index';
import { productDescriptionPlainText } from '@/lib/productDescription';

interface ProductCardProps {
  key?: React.Key;
  product: Product;
  onAddToCart: (product: Product) => void;
  onQuickView: (product: Product) => void;
  onQuickBuy?: (product: Product) => void;
}

export function ProductCard({ product, onAddToCart, onQuickView, onQuickBuy }: ProductCardProps) {
  const availableStock = product.stockQuantity - product.reservedQuantity;
  const isOutOfStock = availableStock <= 0;
  const isLowStock = availableStock > 0 && availableStock <= product.lowStockThreshold;

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-md transition-all duration-200 hover:border-zinc-700 hover:shadow-xl">
      {/* Image & Target Badges */}
      <div
        className="relative aspect-4/3 w-full cursor-pointer overflow-hidden bg-zinc-950"
        onClick={() => onQuickView(product)}
      >
        <img
          src={product.imageUrl}
          alt={product.name}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          referrerPolicy="no-referrer"
          loading="lazy"
        />

        {/* Category Pill */}
        <div className="absolute top-3 left-3">
          <span className="rounded-md border border-zinc-800 bg-zinc-950/90 px-2.5 py-1 text-[11px] font-medium text-zinc-300 backdrop-blur-md">
            {product.category}
          </span>
        </div>

        {/* Stock Status Badge */}
        <div className="absolute top-3 right-3">
          {isOutOfStock ? (
            <span className="rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-[11px] font-bold text-red-400">
              Sold Out
            </span>
          ) : isLowStock ? (
            <span className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-400">
              Only {availableStock} left
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              In Stock
            </span>
          )}
        </div>
      </div>

      {/* Product Content */}
      <div className="flex flex-1 flex-col justify-between space-y-3 p-4">
        <div className="space-y-1.5">
          {/* Rating and SKU */}
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1 text-amber-400">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
              <span className="font-semibold text-zinc-200">{product.rating.toFixed(1)}</span>
              <span className="text-[11px] text-zinc-500">({product.reviewCount})</span>
            </div>
            <span className="font-mono text-[10px] text-zinc-500">SKU: {product.sku}</span>
          </div>

          {/* Title */}
          <h3
            onClick={() => onQuickView(product)}
            className="line-clamp-1 cursor-pointer text-sm font-semibold text-white transition-colors hover:text-indigo-400"
            title={product.name}
          >
            {product.name}
          </h3>

          {/* Description snippet */}
          <p className="line-clamp-2 text-xs leading-relaxed text-zinc-400">
            {productDescriptionPlainText(product.description)}
          </p>
        </div>

        {/* Price & Action Buttons */}
        <div className="space-y-2.5 border-t border-zinc-800 pt-3">
          <div className="flex items-baseline justify-between">
            <div>
              <span className="-mb-0.5 block text-xs text-zinc-400">Price</span>
              <div className="font-mono text-base font-bold text-white">
                KES {(product.price ?? 0).toLocaleString()}
              </div>
            </div>

            {product.compareAtPrice && product.price != null && product.compareAtPrice > product.price && (
              <div className="text-right">
                <span className="block text-[10px] font-semibold text-emerald-400">
                  Save KES {(product.compareAtPrice - product.price).toLocaleString()}
                </span>
                <span className="font-mono text-xs text-zinc-500 line-through">
                  KES {product.compareAtPrice.toLocaleString()}
                </span>
              </div>
            )}
          </div>

          {/* Actions: View Details / Add to Cart / Quick Buy */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onAddToCart(product)}
              disabled={isOutOfStock}
              className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all ${
                isOutOfStock
                  ? 'cursor-not-allowed border border-zinc-700/50 bg-zinc-800 text-zinc-500'
                  : 'border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white'
              }`}
            >
              <ShoppingCart className="h-3.5 w-3.5 text-indigo-400" />
              <span>Add to Cart</span>
            </button>

            <button
              onClick={() => {
                if (onQuickBuy) onQuickBuy(product);
                else onQuickView(product);
              }}
              disabled={isOutOfStock}
              className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all ${
                isOutOfStock
                  ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                  : 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-500'
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              <span>Buy Now</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
