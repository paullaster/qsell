'use server';

import { headers } from 'next/headers';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { parseCouponCodes, PAYMENT_PROVIDERS } from '@/lib/checkout-input';
import { isRecord } from '@/lib/values';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { previewShopBasket, type BasketPromotions } from './basket-preview';

export interface ShopBasketView {
  subtotal: number;
  tax: number;
  /** What the goods come to after promotions, tax included. Delivery is added to it. */
  goodsTotal: number;
  promotions: BasketPromotions;
}

/**
 * Public: what this basket comes to as the order will price it, with the promotions and promo codes that apply. The browser sends
 * only product ids, quantities, the codes typed and the way to pay; every amount is worked out here.
 */
export async function shopBasketAction(raw: unknown): Promise<{ ok: true; data: ShopBasketView } | { ok: false; error: string }> {
  if (!isRecord(raw)) return { ok: false, error: 'Your basket could not be read.' };
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 100) : [];
  const lines = items.flatMap((i) => (isRecord(i) && typeof i.productId === 'string' && i.productId.length <= 100 && typeof i.quantity === 'number' && Number.isFinite(i.quantity) && i.quantity > 0 && i.quantity < 1_000_000 ? [{ productId: i.productId, quantity: i.quantity }] : []));
  if (lines.length === 0 || lines.length !== items.length) return { ok: false, error: 'Your basket could not be read.' };
  const coupons = parseCouponCodes(raw.couponCodes);
  if (!coupons.ok) return { ok: false, error: coupons.error };
  const method = PAYMENT_PROVIDERS.find((p) => p === raw.paymentMethod) ?? null;
  const h = await headers();
  const verdict = await getContainer().rateLimits.hit('shop_delivery_quote_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
  if (!verdict.allowed) return { ok: false, error: waitMessage(verdict.retryAfterSeconds) };
  try {
    const session = await auth();
    const basket = await previewShopBasket(lines, session?.user.customerStoreId ?? null, { couponCodes: coupons.value, paymentMethod: method });
    if (!basket.ok) return { ok: false, error: basket.error };
    return { ok: true, data: { subtotal: basket.subtotal, tax: basket.tax, goodsTotal: basket.goodsTotal, promotions: basket.promotions } };
  } catch (error) {
    console.error('[shop] basket', error);
    return { ok: false, error: 'We could not check your promotions just now.' };
  }
}
