'use client';

import React from 'react';
import { ShoppingCart, Eye, Star, Zap, ShieldCheck, Check } from 'lucide-react';
import { Product } from '@/types/index';

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
    <div className="group relative bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl overflow-hidden transition-all duration-200 flex flex-col shadow-md hover:shadow-xl">
      {/* Image & Target Badges */}
      <div 
        className="relative aspect-4/3 w-full bg-zinc-950 overflow-hidden cursor-pointer" 
        onClick={() => onQuickView(product)}
      >
        <img
          src={product.imageUrl}
          alt={product.name}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          referrerPolicy="no-referrer"
          loading="lazy"
        />

        {/* Category Pill */}
        <div className="absolute top-3 left-3">
          <span className="px-2.5 py-1 rounded-md bg-zinc-950/90 backdrop-blur-md text-zinc-300 text-[11px] font-medium border border-zinc-800">
            {product.category}
          </span>
        </div>

        {/* Stock Status Badge */}
        <div className="absolute top-3 right-3">
          {isOutOfStock ? (
            <span className="px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 border border-red-500/20 text-[11px] font-bold">
              Sold Out
            </span>
          ) : isLowStock ? (
            <span className="px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[11px] font-bold">
              Only {availableStock} left
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[11px] font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              In Stock
            </span>
          )}
        </div>
      </div>

      {/* Product Content */}
      <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
        <div className="space-y-1.5">
          {/* Rating and SKU */}
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1 text-amber-400">
              <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
              <span className="font-semibold text-zinc-200">{product.rating.toFixed(1)}</span>
              <span className="text-zinc-500 text-[11px]">({product.reviewCount})</span>
            </div>
            <span className="text-[10px] text-zinc-500 font-mono">SKU: {product.sku}</span>
          </div>

          {/* Title */}
          <h3 
            onClick={() => onQuickView(product)}
            className="font-semibold text-white text-sm hover:text-indigo-400 transition-colors line-clamp-1 cursor-pointer"
            title={product.name}
          >
            {product.name}
          </h3>

          {/* Description snippet */}
          <p className="text-zinc-400 text-xs line-clamp-2 leading-relaxed">
            {product.description}
          </p>
        </div>

        {/* Price & Action Buttons */}
        <div className="pt-3 border-t border-zinc-800 space-y-2.5">
          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-xs text-zinc-400 block -mb-0.5">Price</span>
              <div className="text-base font-bold text-white font-mono">
                KES {product.price.toLocaleString()}
              </div>
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

          {/* Actions: View Details / Add to Cart / Quick Buy */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onAddToCart(product)}
              disabled={isOutOfStock}
              className={`py-2 px-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                isOutOfStock
                  ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700/50'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 hover:text-white'
              }`}
            >
              <ShoppingCart className="w-3.5 h-3.5 text-indigo-400" />
              <span>Add to Cart</span>
            </button>

            <button
              onClick={() => {
                if (onQuickBuy) onQuickBuy(product);
                else onQuickView(product);
              }}
              disabled={isOutOfStock}
              className={`py-2 px-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                isOutOfStock
                  ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Buy Now</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
