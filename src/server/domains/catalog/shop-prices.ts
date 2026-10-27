import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { readCompanyRow } from '@/server/domains/storefront/company-read';
import { priceItemFor } from '@/server/domains/pricing/service';
import { limitsOf } from '@/lib/quantity-limits';
import type { PublicProduct } from '@/types/index';

/** The signed-in shopper's customer record, when they have one: the price lists meant for them apply to what they are shown. */
async function shopperCustomerId(): Promise<string | null> {
  try {
    return (await auth())?.user.customerStoreId ?? null;
  } catch {
    // An unreadable session is simply a visitor.
    return null;
  }
}

/**
 * Puts the pricing engine's price on each product, so the shop shows what it will charge: the same engine, the same standard
 * price, the same lists, for the same customer and channel the order will be priced with. Each product is priced at the quantity
 * given for it, else at the least that can be bought (one, when there is no minimum). Two queries however many products.
 * If the engine cannot be reached the stored price is shown and checkout prices the order itself.
 */
export async function withShopPrices(products: PublicProduct[], quantities: ReadonlyMap<string, number> = new Map()): Promise<PublicProduct[]> {
  if (products.length === 0) return products;
  try {
    const company = await readCompanyRow();
    const results = await getContainer().pricing.priceLines(
      company.id,
      { customerId: await shopperCustomerId(), channel: 'ecommerce', salesType: 'cash' },
      products.map((product) => priceItemFor(product, quantities.get(product.id) ?? limitsOf(product).minQty ?? 1)),
    );
    return products.map((product, index) => {
      const unitPrice = results[index]?.unitPrice ?? null;
      return unitPrice === null ? product : { ...product, price: unitPrice };
    });
  } catch (error) {
    console.error('[shop] prices', error);
    return products;
  }
}
