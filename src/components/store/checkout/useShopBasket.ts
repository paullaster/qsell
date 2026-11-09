'use client';

import { useEffect, useState } from 'react';
import { shopBasketAction, type ShopBasketView } from '@/server/domains/orders/shop-basket-actions';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';

export type BasketPhase = { phase: 'loading' } | { phase: 'ok'; basket: ShopBasketView } | { phase: 'error'; error: string };

/**
 * What the basket comes to on the server, with the promotions and promo codes that apply. Asked whenever the basket, the codes or the
 * way to pay change (after a short pause); an answer to an earlier question is never shown for a later one.
 */
export function useShopBasket(input: { items: { productId: string; quantity: number }[]; couponCodes: string[]; paymentMethod: string }): BasketPhase {
  const request = JSON.stringify(input);
  const asked = useDebouncedValue(request, 400);
  const [answer, setAnswer] = useState<{ key: string; outcome: { ok: true; basket: ShopBasketView } | { ok: false; error: string } } | null>(null);

  useEffect(() => {
    let live = true;
    void shopBasketAction(JSON.parse(asked)).then((r) => {
      if (live) setAnswer({ key: asked, outcome: r.ok ? { ok: true, basket: r.data } : { ok: false, error: r.error } });
    });
    return () => {
      live = false;
    };
  }, [asked]);

  if (answer?.key !== request) return { phase: 'loading' };
  return answer.outcome.ok ? { phase: 'ok', basket: answer.outcome.basket } : { phase: 'error', error: answer.outcome.error };
}
