import type { InventoryKind } from '@/lib/inventory-kind';

/**
 * Whether a product is offered for sale (shop, quotes, saved lists), given what its business classification says, how it is
 * managed, and its selling price. A classification that is not sold from the shop never is. A service with no selling price is
 * not either: it is billed from elsewhere (delivery is charged from the delivery rates), so it needs no price and stays out of the
 * shop instead of appearing there without one. Goods keep the classification's answer, and so do services that have a price.
 */
export function productSellability(input: { classificationSellable: boolean; kind: InventoryKind; price: number | null | undefined }): boolean {
  if (!input.classificationSellable) return false;
  if (input.kind !== 'service') return true;
  return typeof input.price === 'number' && Number.isFinite(input.price) && input.price > 0;
}
