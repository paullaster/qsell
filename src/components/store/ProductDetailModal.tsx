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
  CreditCard
} from 'lucide-react';
import { Product } from '@/types/index';

interface ProductDetailModalProps {
  product: Product | null;
  onClose: () => void;
  onAddToCart: (product: Product, quantity: number) => void;
  onQuickBuy?: (product: Product) => void;
}

export function ProductDetailModal({ product, onClose, onAddToCart, onQuickBuy }: ProductDetailModalProps) {
  if (!product) return null;

  const [quantity, setQuantity] = useState<number>(1);
  const availableStock = product.stockQuantity - product.reservedQuantity;
  const isOutOfStock = availableStock <= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-3xl bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col md:flex-row max-h-[90vh]">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 rounded-lg bg-zinc-950/80 text-zinc-400 hover:text-white border border-zinc-800 transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Product Image & SKU Badge */}
        <div className="md:w-1/2 bg-zinc-950 p-6 flex flex-col items-center justify-center relative overflow-hidden">
          <img
            src={product.imageUrl}
            alt={product.name}
            className="w-full h-auto max-h-80 object-cover rounded-xl shadow-md"
            referrerPolicy="no-referrer"
          />
          <div className="absolute top-4 left-4">
            <span className="px-2.5 py-1 rounded-md bg-zinc-900/90 text-zinc-300 border border-zinc-700 text-xs font-mono">
              SKU: {product.sku}
            </span>
          </div>
        </div>

        {/* Product Details */}
        <div className="md:w-1/2 p-6 flex flex-col justify-between overflow-y-auto space-y-4">
          <div className="space-y-3">
            {/* Category & Rating */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wider">
                {product.category}
              </span>
              <div className="flex items-center text-amber-400 text-xs font-semibold">
                <Star className="w-3.5 h-3.5 fill-amber-400 mr-1" />
                {product.rating.toFixed(1)} <span className="text-zinc-500 font-normal ml-1">({product.reviewCount} reviews)</span>
              </div>
            </div>

            <h2 className="text-lg sm:text-xl font-bold text-white leading-snug">{product.name}</h2>

            {/* Price Box */}
            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-zinc-400 block uppercase tracking-wider">Price</span>
                <span className="text-2xl font-bold text-white font-mono">
                  KES {product.price.toLocaleString()}
                </span>
              </div>
              {product.compareAtPrice && product.compareAtPrice > product.price && (
                <div className="text-right">
                  <span className="text-[10px] text-emerald-400 font-semibold block">
                    Save KES {(product.compareAtPrice - product.price).toLocaleString()}
                  </span>
                  <span className="text-xs text-zinc-500 line-through font-mono">
                    KES {product.compareAtPrice.toLocaleString()}
                  </span>
                </div>
              )}
            </div>

            {/* Stock Availability */}
            <div className="flex items-center justify-between text-xs py-1">
              <span className="text-zinc-400 font-medium">Availability:</span>
              {isOutOfStock ? (
                <span className="text-red-400 font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-400"></span>
                  Out of Stock
                </span>
              ) : (
                <span className="text-emerald-400 font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                  In Stock ({availableStock} units)
                </span>
              )}
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-zinc-300">Description:</span>
              <p className="text-zinc-300 text-xs leading-relaxed">{product.description}</p>
            </div>
          </div>

          {/* Action & Quantity */}
          <div className="space-y-3 pt-3 border-t border-zinc-800">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400 font-medium">Quantity:</span>
              <div className="flex items-center bg-zinc-950 rounded-lg p-1 border border-zinc-800">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  disabled={quantity <= 1 || isOutOfStock}
                  className="w-7 h-7 flex items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 font-bold disabled:opacity-40 cursor-pointer text-xs"
                >
                  -
                </button>
                <span className="w-8 text-center font-mono text-xs text-white font-semibold">{quantity}</span>
                <button
                  onClick={() => setQuantity(Math.min(availableStock, quantity + 1))}
                  disabled={quantity >= availableStock || isOutOfStock}
                  className="w-7 h-7 flex items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 font-bold disabled:opacity-40 cursor-pointer text-xs"
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
                className="py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-semibold text-xs flex items-center justify-center gap-1.5 border border-zinc-700 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <ShoppingCart className="w-4 h-4 text-indigo-400" />
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
                className="py-2.5 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-indigo-600/20 transition-all disabled:opacity-50 cursor-pointer"
              >
                <Zap className="w-4 h-4" />
                <span>Buy Now</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
