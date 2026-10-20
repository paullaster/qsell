'use client';

import { useState } from 'react';
import { X, ShoppingCart, Star, Zap } from 'lucide-react';
import { type PublicProduct } from '@/types/index';
import { AppImage } from '@/components/ui/AppImage';
import { ProductDescriptionView } from '@/components/ui/ProductDescriptionView';
import { visibleSpecifications } from '@/lib/product-specifications';
import { QuantityStepper } from '@/components/store/QuantityStepper';
import { availableOf, cartQuantityWords, decimalsOf, perUnitSuffix } from '@/lib/cart-quantity';

interface ProductDetailModalProps {
  product: PublicProduct | null;
  onClose: () => void;
  onAddToCart: (product: PublicProduct, quantity: number) => void;
  onQuickBuy?: (product: PublicProduct) => void;
}

export function ProductDetailModal({ product, ...rest }: ProductDetailModalProps) {
  // Keyed by product, so the chosen quantity starts again for each product shown.
  return product === null ? null : <ProductDetails key={product.id} product={product} {...rest} />;
}

function ProductDetails({
  product,
  onClose,
  onAddToCart,
  onQuickBuy,
}: Omit<ProductDetailModalProps, 'product'> & { product: PublicProduct }) {
  const [quantity, setQuantity] = useState<number>(1);
  const decimals = decimalsOf(product);
  const specifications = visibleSpecifications(product.specifications);
  const availableStock = availableOf(product);
  const isOutOfStock = availableStock <= 0;

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-backdrop/80 p-4 backdrop-blur-sm">
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl md:flex-row">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 cursor-pointer rounded-lg border border-line bg-surface/80 p-2 text-fg-muted transition-colors hover:text-fg-strong"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Product Image & SKU Badge */}
        <div className="relative flex flex-col items-center justify-center overflow-hidden bg-surface p-6 md:w-1/2">
          <AppImage
            src={product.imageUrl}
            alt={product.name}
            width={800}
            height={600}
            sizes="(max-width: 768px) 100vw, 50vw"
            className="h-auto max-h-80 w-full rounded-xl object-cover shadow-md"
            referrerPolicy="no-referrer"
          />
          <div className="absolute top-4 left-4">
            <span className="rounded-md border border-line-strong bg-surface-sunken/90 px-2.5 py-1 font-mono text-xs text-fg">
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
              <div className="flex items-center text-xs font-semibold text-amber-600">
                <Star className="mr-1 h-3.5 w-3.5 fill-amber-400" />
                {product.rating.toFixed(1)}{' '}
                <span className="ml-1 font-normal text-fg-subtle">
                  ({product.reviewCount} reviews)
                </span>
              </div>
            </div>

            <h2 className="text-lg leading-snug font-bold text-fg-strong sm:text-xl">
              {product.name}
            </h2>

            {/* Price Box */}
            <div className="flex items-center justify-between rounded-xl border border-line bg-surface p-3.5">
              <div>
                <span className="block text-[10px] tracking-wider text-fg-muted uppercase">
                  Price
                </span>
                <span className="font-mono text-2xl font-bold text-fg-strong">
                  KES {(product.price ?? 0).toLocaleString()}
                  {perUnitSuffix(product) === '' ? null : (
                    <span className="text-sm font-normal text-fg-muted">
                      {perUnitSuffix(product)}
                    </span>
                  )}
                </span>
              </div>
              {product.compareAtPrice != null &&
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

            {/* Stock Availability */}
            <div className="flex items-center justify-between py-1 text-xs">
              <span className="font-medium text-fg-muted">Availability:</span>
              {isOutOfStock ? (
                <span className="flex items-center gap-1.5 font-semibold text-red-600">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  Out of Stock
                </span>
              ) : (
                <span className="flex items-center gap-1.5 font-semibold text-emerald-600">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  In Stock ({cartQuantityWords(availableStock, product)}
                  {decimals > 0 ? '' : ' units'})
                </span>
              )}
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-fg">Description:</span>
              <ProductDescriptionView description={product.description} dense />
            </div>

            {specifications.length > 0 && (
              <section aria-labelledby="product-specifications" className="space-y-1.5">
                <h3 id="product-specifications" className="text-xs font-semibold text-fg">
                  Specifications:
                </h3>
                <dl className="divide-y divide-line rounded-lg border border-line bg-surface text-xs">
                  {specifications.map((spec) => (
                    <div
                      key={`${spec.key}:${spec.value}`}
                      className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-3 py-2"
                    >
                      <dt className="font-medium break-words text-fg-muted">{spec.key}</dt>
                      <dd className="break-words text-fg-strong">{spec.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>

          {/* Action & Quantity */}
          <div className="space-y-3 border-t border-line pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-muted">Quantity:</span>
              <QuantityStepper
                label={`quantity of ${product.name}`}
                value={quantity}
                decimals={decimals}
                unitCode={product.baseUnitCode}
                available={availableStock}
                onChange={setQuantity}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  onAddToCart(product, quantity);
                  onClose();
                }}
                disabled={isOutOfStock}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-line-strong bg-surface-sunken px-3 py-2.5 text-xs font-semibold text-fg-strong transition-colors hover:bg-hover disabled:opacity-50"
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
