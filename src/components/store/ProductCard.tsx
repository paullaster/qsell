'use client';

import React from 'react';
import { ShoppingCart, Eye, Star, Zap, ShieldCheck, Check } from 'lucide-react';
import { type Product } from '@/types/index';
import { productDescriptionPlainText } from '@/lib/productDescription';
import { AppImage } from '@/components/ui/AppImage';

interface ProductCardProps {
  key?: React.Key;
  product: Product;
  onAddToCart: (product: Product) => void;
  onQuickView: (product: Product) => void;
  onQuickBuy?: (product: Product) => void;
  preloadImage?: boolean;
}

export function ProductCard({
  product,
  onAddToCart,
  onQuickView,
  onQuickBuy,
  preloadImage,
}: ProductCardProps) {
  const availableStock = product.stockQuantity - product.reservedQuantity;
  const isOutOfStock = availableStock <= 0;
  const isLowStock = availableStock > 0 && availableStock <= product.lowStockThreshold;

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface-raised shadow-md transition-all duration-200 hover:border-line-strong hover:shadow-xl">
      {/* Image & Target Badges */}
      <div
        className="relative aspect-4/3 w-full cursor-pointer overflow-hidden bg-surface"
        onClick={() => onQuickView(product)}
      >
        <AppImage
          src={product.imageUrl}
          alt={product.name}
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          className="object-cover transition-transform duration-300 group-hover:scale-105"
          referrerPolicy="no-referrer"
          preload={preloadImage}
        />

        {/* Category Pill */}
        <div className="absolute top-3 left-3">
          <span className="rounded-md border border-line bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-fg backdrop-blur-md">
            {product.category}
          </span>
        </div>

        {/* Stock Status Badge */}
        <div className="absolute top-3 right-3">
          {isOutOfStock ? (
            <span className="rounded-md border border-line-strong bg-surface-sunken px-2.5 py-1 text-[11px] font-bold text-destructive">
              Sold Out
            </span>
          ) : isLowStock ? (
            <span className="rounded-md border border-line-strong bg-surface-sunken px-2.5 py-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
              Only {availableStock} left
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
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
            <div className="flex items-center gap-1 text-amber-600">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-600" />
              <span className="font-semibold text-fg-strong">{product.rating.toFixed(1)}</span>
              <span className="text-[11px] text-fg-subtle">({product.reviewCount})</span>
            </div>
            <span className="font-mono text-[10px] text-fg-subtle">SKU: {product.sku}</span>
          </div>

          {/* Title */}
          <h3
            onClick={() => onQuickView(product)}
            className="line-clamp-1 cursor-pointer text-sm font-semibold text-fg-strong transition-colors hover:text-indigo-400"
            title={product.name}
          >
            {product.name}
          </h3>

          {/* Description snippet */}
          <p className="line-clamp-2 text-xs leading-relaxed text-fg-muted">
            {productDescriptionPlainText(product.description)}
          </p>
        </div>

        {/* Price & Action Buttons */}
        <div className="space-y-2.5 border-t border-line pt-3">
          <div className="flex items-baseline justify-between">
            <div>
              <span className="-mb-0.5 block text-xs text-fg-muted">Price</span>
              <div className="font-mono text-base font-bold text-fg-strong">
                KES {(product.price ?? 0).toLocaleString()}
              </div>
            </div>

            {product.compareAtPrice &&
              product.price != null &&
              product.compareAtPrice > product.price && (
                <div className="text-right">
                  <span className="block text-[10px] font-semibold text-emerald-600">
                    Save KES {(product.compareAtPrice - product.price).toLocaleString()}
                  </span>
                  <span className="font-mono text-xs text-fg-subtle line-through">
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
                  ? 'cursor-not-allowed border border-line-strong/50 bg-surface-sunken text-fg-subtle'
                  : 'border border-line-strong bg-surface-sunken text-fg-strong hover:bg-hover hover:text-fg-strong'
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
                  ? 'cursor-not-allowed bg-surface-sunken text-fg-subtle'
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
