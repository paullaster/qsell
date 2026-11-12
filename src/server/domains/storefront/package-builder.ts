import { getContainer } from '@/server/di/container';
import type { ShopBuilder } from '@/server/domains/pricing/package-shop-service';

/**
 * The builder for a product page, as a promise the page hands on without waiting for it (null when the product is not a package).
 * A failure is logged and treated as "not a package": the ordinary purchase panel shows, and the server refuses a package
 * product added as it stands anyway.
 */
export function packageBuilderFor(productId: string): Promise<ShopBuilder | null> {
  return (async () => {
    const container = getContainer();
    return await container.packageShop.builder((await container.companySettings.ensureSeeded()).id, productId);
  })().catch((error: unknown) => {
    console.error('[packages] builder', error);
    return null;
  });
}
