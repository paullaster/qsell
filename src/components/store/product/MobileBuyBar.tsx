'use client';

import { useEffect, useState } from 'react';
import { ShoppingCart } from 'lucide-react';
import type { PublicProduct } from '@/types/index';
import { availableOf } from '@/lib/cart-quantity';
import { Price } from '@/components/store/Price';
import { useCartActions } from '@/components/store/cart/useCartActions';

/** On a phone, the price and "Add to cart" stay at the foot of the screen once the main buttons have scrolled away. */
export function MobileBuyBar({ product, targetId }: { product: PublicProduct; targetId: string }) {
  const [visible, setVisible] = useState(false);
  const { addToCart } = useCartActions();
  useEffect(() => {
    const target = document.getElementById(targetId);
    if (target === null) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry !== undefined && !entry.isIntersecting && entry.boundingClientRect.top < 0), { threshold: 0 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId]);
  if (availableOf(product) <= 0) return null;
  return (
    <div
      aria-hidden={!visible}
      className={`fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-line bg-surface/95 px-4 py-2.5 backdrop-blur-md transition-transform md:hidden ${visible ? 'translate-y-0' : 'pointer-events-none translate-y-full'}`}
    >
      <div className="min-w-0"><Price product={product} /></div>
      <button type="button" tabIndex={visible ? 0 : -1} onClick={() => addToCart(product, 1)} className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-5 text-sm font-bold text-white hover:bg-indigo-500">
        <ShoppingCart className="h-4 w-4" aria-hidden="true" />Add to cart
      </button>
    </div>
  );
}
