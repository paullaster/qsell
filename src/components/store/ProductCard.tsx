'use client';

import React from 'react';
import { ShoppingCart, Eye, Star, Zap, ShieldCheck, Check } from 'lucide-react';
import { type PublicProduct } from '@/types/index';
import { productDescriptionPlainText } from '@/lib/productDescription';
import { AppImage } from '@/components/ui/AppImage';
import { availableOf, cartQuantityWords, perUnitSuffix } from '@/lib/cart-quantity';

interface ProductCardProps {
  key?: React.Key;
  product: PublicProduct;
  onAddToCart: (product: PublicProduct) => void;
  onQuickView: (product: PublicProduct) => void;
  onQuickBuy?: (product: PublicProduct) => void;
  preloadImage?: boolean;
}

export function ProductCard({
  product,
  onAddToCart,
  onQuickView,
  onQuickBuy,
  preloadImage,
}: ProductCardProps) {
  const availableStock = availableOf(product);
  const isOutOfStock = availableStock <= 0;
  const isLowStock = availableStock > 0 && availableStock <= product.lowStockThreshold;

  return (
    <div className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-raised shadow-md transition-all duration-200 hover:border-line-strong hover:shadow-xl">
      {/* Stretched action makes the entire card open its product page. The cart
       * and buy controls are layered above it as separate, working buttons. */}
      <button
        type="button"
        onClick={() => onQuickView(product)}
        aria-label={`View ${product.name}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-xl touch-manipulation"
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 flex-col justify-between">
      {/* Image & Target Badges */}
      <div
        className="relative aspect-4/3 w-full overflow-hidden bg-surface"
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
          <span className="block max-w-40 truncate rounded-md border border-line bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-fg backdrop-blur-md">
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
              Only {cartQuantityWords(availableStock, product)} left
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-md border border-line bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              In Stock
            </span>
          )}
        </div>
      </div>

      {/* Product Content */}
      <div className="flex min-w-0 flex-1 flex-col justify-between space-y-3 p-4">
        <div className="min-w-0 space-y-1.5">
          {/* Rating and SKU */}
          <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
            <div className="flex min-w-0 items-center gap-1 text-amber-600">
              <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-600" />
              <span className="font-semibold text-fg-strong">{product.rating.toFixed(1)}</span>
              <span className="truncate text-[11px] text-fg-subtle">({product.reviewCount})</span>
            </div>
            <span className="max-w-[55%] truncate font-mono text-[10px] text-fg-subtle" title={`SKU: ${product.sku}`}>SKU: {product.sku}</span>
          </div>

          {/* Title */}
          <h3
            className="line-clamp-2 text-sm leading-snug font-semibold text-fg-strong"
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
                {perUnitSuffix(product) === '' ? null : (
                  <span className="text-xs font-normal text-fg-muted">{perUnitSuffix(product)}</span>
                )}
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
          <div className="pointer-events-auto relative z-20 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onAddToCart(product)}
              disabled={isOutOfStock}
              aria-label={`Add ${product.name} to cart`}
              className={`flex min-h-11 min-w-0 cursor-pointer touch-manipulation items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all ${
                isOutOfStock
                  ? 'cursor-not-allowed border border-line-strong/50 bg-surface-sunken text-fg-subtle'
                  : 'border border-line-strong bg-surface-sunken text-fg-strong hover:bg-hover hover:text-fg-strong'
              }`}
            >
              <ShoppingCart className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
              <span>Add to Cart</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (onQuickBuy) onQuickBuy(product);
                else onQuickView(product);
              }}
              disabled={isOutOfStock}
              aria-label={`Buy ${product.name} now`}
              className={`flex min-h-11 min-w-0 cursor-pointer touch-manipulation items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all ${
                isOutOfStock
                  ? 'cursor-not-allowed bg-surface-sunken text-fg-subtle'
                  : 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-500'
              }`}
            >
              <Zap className="h-3.5 w-3.5 shrink-0" />
              <span>Buy Now</span>
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
