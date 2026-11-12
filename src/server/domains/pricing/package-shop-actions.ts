'use server';

import { getContainer } from '@/server/di/container';
import { parsePackageLine, parsePackageLines, parseServings } from './domain/package-shop-input';
import type { BasketLineView } from './domain/package-shop';
import type { ShopBuilder } from './package-shop-service';

export type ShopResult<T> = { ok: true; data: T } | { ok: false; error: string };

const failed = (error: unknown): { ok: false; error: string } => {
  console.error('[packages] shop', error);
  return { ok: false, error: 'Could not check this package. Please try again.' };
};

const company = async (): Promise<string> => (await getContainer().companySettings.ensureSeeded()).id;

/** Public: the builder for a package product (null when the product is not a package the shop offers), with what stock allows for this many servings. */
export async function packageBuilderAction(productId: unknown, servings?: unknown): Promise<ShopResult<ShopBuilder | null>> {
  if (typeof productId !== 'string' || productId.length === 0 || productId.length > 100) return { ok: true, data: null };
  try {
    return { ok: true, data: await getContainer().packageShop.builder(await company(), productId, parseServings(servings)) };
  } catch (error) {
    return failed(error);
  }
}

/** Public: prices and checks one package line, as it would be at checkout. The browser sends only ids and counts. */
export async function checkPackageLineAction(raw: unknown): Promise<ShopResult<BasketLineView>> {
  const line = parsePackageLine(raw);
  if (line === null) return { ok: true, data: { ok: false, problems: ['This choice could not be read.'] } };
  try {
    const [checked] = await getContainer().packageShop.basket(await company(), [line]);
    return { ok: true, data: checked ?? { ok: false, problems: ['This package is not available any more.'] } };
  } catch (error) {
    return failed(error);
  }
}

/** Public: the package lines of a basket, priced and checked together (each sees the stock the lines before it take). */
export async function checkPackageBasketAction(raw: unknown): Promise<ShopResult<BasketLineView[]>> {
  const lines = parsePackageLines(raw);
  if (lines.length === 0) return { ok: true, data: [] };
  try {
    return { ok: true, data: await getContainer().packageShop.basket(await company(), lines) };
  } catch (error) {
    return failed(error);
  }
}
