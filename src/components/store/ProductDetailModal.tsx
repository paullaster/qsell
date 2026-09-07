'use client';

import { useState } from 'react';
import {
  X,
  ShoppingCart,
  Star,
  ShieldCheck,
  Truck,
  RotateCcw,
  Zap,
  CheckCircle2,
  Tag,
  Smartphone,
  CreditCard,
} from 'lucide-react';
import { type Product } from '@/types/index';
import { ProductDescriptionView } from '@/components/ui/ProductDescriptionView';

interface ProductDetailModalProps {
  product: Product | null;
  onClose: () => void;
  onAddToCart: (product: Product, quantity: number) => void;
  onQuickBuy?: (product: Product) => void;
}

export function ProductDetailModal({
  product,
  onClose,
  onAddToCart,
  onQuickBuy,
}: ProductDetailModalProps) {
  if (!product) return null;

  const [quantity, setQuantity] = useState<number>(1);
  const availableStock = product.stockQuantity - product.reservedQuantity;
  const isOutOfStock = availableStock <= 0;

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl md:flex-row">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950/80 p-2 text-zinc-400 transition-colors hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Product Image & SKU Badge */}
        <div className="relative flex flex-col items-center justify-center overflow-hidden bg-zinc-950 p-6 md:w-1/2">
          <img
            src={product.imageUrl}
            alt={product.name}
            className="h-auto max-h-80 w-full rounded-xl object-cover shadow-md"
            referrerPolicy="no-referrer"
          />
          <div className="absolute top-4 left-4">
            <span className="rounded-md border border-zinc-700 bg-zinc-900/90 px-2.5 py-1 font-mono text-xs text-zinc-300">
              SKU: {product.sku}
            </span>
          </div>
        </div>

        {/* Product Details */}
        <div className="flex flex-col justify-between space-y-4 overflow-y-auto p-6 md:w-1/2">
          <div className="space-y-3">
            {/* Category & Rating */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wider text-indigo-400 uppercase">
                {product.category}
              </span>
              <div className="flex items-center text-xs font-semibold text-amber-400">
                <Star className="mr-1 h-3.5 w-3.5 fill-amber-400" />
                {product.rating.toFixed(1)}{' '}
                <span className="ml-1 font-normal text-zinc-500">
                  ({product.reviewCount} reviews)
                </span>
              </div>
            </div>

            <h2 className="text-lg leading-snug font-bold text-white sm:text-xl">{product.name}</h2>

            {/* Price Box */}
            <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
              <div>
                <span className="block text-[10px] tracking-wider text-zinc-400 uppercase">
                  Price
                </span>
                <span className="font-mono text-2xl font-bold text-white">
                  KES {(product.price ?? 0).toLocaleString()}
                </span>
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

            {/* Stock Availability */}
            <div className="flex items-center justify-between py-1 text-xs">
              <span className="font-medium text-zinc-400">Availability:</span>
              {isOutOfStock ? (
                <span className="flex items-center gap-1.5 font-semibold text-red-400">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  Out of Stock
                </span>
              ) : (
                <span className="flex items-center gap-1.5 font-semibold text-emerald-400">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  In Stock ({availableStock} units)
                </span>
              )}
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-zinc-300">Description:</span>
              <ProductDescriptionView description={product.description} dense />
            </div>
          </div>

          {/* Action & Quantity */}
          <div className="space-y-3 border-t border-zinc-800 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">Quantity:</span>
              <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-950 p-1">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  disabled={quantity <= 1 || isOutOfStock}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-xs font-bold text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  -
                </button>
                <span className="w-8 text-center font-mono text-xs font-semibold text-white">
                  {quantity}
                </span>
                <button
                  onClick={() => setQuantity(Math.min(availableStock, quantity + 1))}
                  disabled={quantity >= availableStock || isOutOfStock}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-xs font-bold text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  onAddToCart(product, quantity);
                  onClose();
                }}
                disabled={isOutOfStock}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-xs font-semibold text-zinc-100 transition-colors hover:bg-zinc-700 disabled:opacity-50"
              >
                <ShoppingCart className="h-4 w-4 text-indigo-400" />
                <span>Add to Cart</span>
              </button>

              <button
                onClick={() => {
                  if (onQuickBuy) {
                    onClose();
                    onQuickBuy(product);
                  }
                }}
                disabled={isOutOfStock}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 disabled:opacity-50"
              >
                <Zap className="h-4 w-4" />
                <span>Buy Now</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
