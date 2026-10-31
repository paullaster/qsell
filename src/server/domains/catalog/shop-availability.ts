import { getContainer } from '@/server/di/container';
import type { PublicProduct } from '@/types/index';

/**
 * What the shop may sell of each product. While the per-location ledger is the truth, a product's own two counters add up every
 * location, including a quarantine, a van on the road or a place that does not sell to the web shop; the shop would offer stock it
 * cannot sell. So the shop is told the stock of the places that do sell to it, in the same two numbers it already reads
 * (on hand and promised), and nothing else in the shop changes. Without the ledger the counters are the truth and nothing is touched.
 * Design: docs/architecture/stock-locations.md §6.1 and §9.
 */
export async function withShopAvailability(products: PublicProduct[]): Promise<PublicProduct[]> {
  if (products.length === 0) return products;
  try {
    const container = getContainer();
    if (!(await container.stockSettings.isLedgerMode())) return products;
    const found = await container.stockAvailability.forProducts(products.map((p) => p.id), 'ecommerce');
    return products.map((p) => {
      const a = found.get(p.id);
      return a === undefined ? p : { ...p, stockQuantity: a.onHand, reservedQuantity: a.reserved };
    });
  } catch (error) {
    console.error('[shop] availability', error);
    return products;
  }
}
