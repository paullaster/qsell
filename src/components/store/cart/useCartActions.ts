'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { PublicProduct } from '@/types/index';
import { cartQuantityWords } from '@/lib/cart-quantity';
import { useCart } from '@/components/store/cart/CartProvider';
import { useToast } from '@/components/store/ToastProvider';

/** "Add to cart" and "Buy now" for a product, each telling the shopper what happened in plain words. */
export function useCartActions() {
  const cart = useCart();
  const toast = useToast();
  const router = useRouter();

  const addToCart = useCallback(
    (product: PublicProduct, quantity = 1): boolean => {
      const outcome = cart.add(product, quantity);
      if (outcome === 'sold_out') {
        toast({ type: 'error', title: 'Sold out', message: `${product.name} is out of stock right now.` });
        return false;
      }
      if (outcome === 'short_of_minimum') {
        toast({ type: 'error', title: 'Not enough in stock', message: `${product.name} is sold in lots of at least ${cartQuantityWords(product.minOrderQty ?? 1, product)}, and there is less than that in stock.` });
        return false;
      }
      if (outcome === 'at_maximum') {
        toast({ type: 'warning', title: 'Added, up to the most you can buy', message: `The most you can buy of ${product.name} is ${cartQuantityWords(product.maxOrderQty ?? 1, product)}.` });
        return true;
      }
      if (outcome === 'capped') {
        toast({ type: 'warning', title: 'Added, up to what is in stock', message: `Only ${cartQuantityWords(product.stockQuantity - product.reservedQuantity, product)} of ${product.name} available.` });
        return true;
      }
      toast({ type: 'success', title: 'Added to your cart', message: `${product.name} is in your cart.` });
      return true;
    },
    [cart, toast],
  );

  const buyNow = useCallback(
    (product: PublicProduct, quantity = 1) => {
      // Straight to checkout, where the cart is shown in full before anything is paid.
      if (addToCart(product, quantity)) router.push('/checkout');
    },
    [addToCart, router],
  );

  return { addToCart, buyNow };
}
