'use client';

import Link from 'next/link';
import { ShoppingCart, Zap } from 'lucide-react';
import { type PublicProduct } from '@/types/index';
import { productDescriptionPlainText } from '@/lib/productDescription';
import { AppImage } from '@/components/ui/AppImage';
import { productHref } from '@/lib/product-link';
import { availableOf } from '@/lib/cart-quantity';
import { Price } from '@/components/store/Price';
import { Rating } from '@/components/store/Rating';
import { StockBadge } from '@/components/store/StockBadge';
import { ImagePlaceholder } from '@/components/store/ImagePlaceholder';
import { WishlistButton } from '@/components/store/wishlist/WishlistButton';
import { useCartActions } from '@/components/store/cart/useCartActions';

interface ProductCardProps {
  product: PublicProduct;
  /** The first cards on a page load their picture straight away. */
  preloadImage?: boolean;
}

/** One product in a grid. The picture and name are a real link to its page; the two buttons beside them act on the cart. */
export function ProductCard({ product, preloadImage = false }: ProductCardProps) {
  const { addToCart, buyNow } = useCartActions();
  const isOutOfStock = availableOf(product) <= 0;
  const href = productHref(product);

  return (
    <article className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-raised shadow-md transition-all duration-200 hover:border-line-strong hover:shadow-xl">
      <div className="relative aspect-square w-full overflow-hidden bg-white">
        {product.imageUrl.trim() === '' ? <ImagePlaceholder /> : null}
        <AppImage
          src={product.imageUrl}
          alt=""
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          className="object-contain p-3 transition-transform duration-300 group-hover:scale-[1.03]"
          referrerPolicy="no-referrer"
          preload={preloadImage}
        />
        <div className="absolute top-3 right-3">
          <StockBadge product={product} />
        </div>
        <div className="absolute bottom-2 left-2 z-10">
          <WishlistButton product={product} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1.5">
          {product.category === '' ? null : <p className="truncate text-xs font-medium text-fg-muted">{product.category}</p>}
          <h3 className="line-clamp-2 text-sm leading-snug font-semibold text-fg-strong" title={product.name}>
            {/* The link covers the whole card, so the picture, the name and the empty space all open the product. */}
            <Link href={href} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-indigo-500">
              {product.name}
            </Link>
          </h3>
          <Rating rating={product.rating} reviewCount={product.reviewCount} />
          <p className="line-clamp-2 text-sm leading-relaxed text-fg-muted">{productDescriptionPlainText(product.description)}</p>
        </div>

        <div className="space-y-3 border-t border-line pt-3">
          <Price product={product} />
          <div className="relative z-10 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => addToCart(product)}
              disabled={isOutOfStock}
              aria-label={`Add ${product.name} to cart`}
              className="flex min-h-11 min-w-0 cursor-pointer touch-manipulation items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface-sunken px-2.5 py-2 text-sm font-semibold text-fg-strong transition-all hover:bg-hover disabled:cursor-not-allowed disabled:text-fg-subtle disabled:opacity-60"
            >
              <ShoppingCart className="h-4 w-4 shrink-0 text-indigo-400" aria-hidden="true" />
              <span>Add</span>
            </button>
            <button
              type="button"
              onClick={() => buyNow(product)}
              disabled={isOutOfStock}
              aria-label={`Buy ${product.name} now`}
              className="flex min-h-11 min-w-0 cursor-pointer touch-manipulation items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2 py-2 text-sm font-semibold whitespace-nowrap text-white shadow-md shadow-indigo-600/20 transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-subtle disabled:shadow-none"
            >
              <Zap className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Buy now</span>
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
