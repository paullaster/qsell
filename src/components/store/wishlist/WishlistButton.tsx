'use client';

import { Heart } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { PublicProduct } from '@/types/index';
import { useWishlist } from '@/components/store/wishlist/WishlistProvider';

/** The heart: save a product for later, or take it off the list. */
export function WishlistButton({
  product,
  variant = 'icon',
}: {
  product: Pick<PublicProduct, 'id' | 'name'>;
  variant?: 'icon' | 'text';
}) {
  const wishlist = useWishlist();
  const saved = wishlist.has(product.id);
  const label = saved
    ? `Remove ${product.name} from saved products`
    : `Save ${product.name} for later`;
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    wishlist.toggle(product.id, product.name);
  };
  if (variant === 'text') {
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={saved}
        disabled={!wishlist.ready}
        onClick={toggle}
        className="inline-flex min-h-11 min-w-11 cursor-pointer touch-manipulation items-center gap-2 rounded-lg px-3 text-sm font-medium text-fg-muted hover:bg-hover hover:text-fg-strong disabled:cursor-wait disabled:opacity-60"
      >
        <Heart
          className={`h-4 w-4 ${saved ? 'fill-rose-500 text-rose-500' : ''}`}
          aria-hidden="true"
        />
        {saved ? 'Saved' : 'Save for later'}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={label}
      title={label}
      disabled={!wishlist.ready}
      onClick={toggle}
      className="relative z-20 flex h-11 w-11 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-white/90 text-fg-muted shadow hover:text-rose-500 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-wait disabled:opacity-60"
    >
      <Heart
        className={`h-5 w-5 ${saved ? 'fill-rose-500 text-rose-500' : ''}`}
        aria-hidden="true"
      />
    </button>
  );
}
