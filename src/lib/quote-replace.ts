import type { CatalogueProduct } from '@/lib/catalogue-entry';

/** The parts of a quote line that replacing its product reads or changes. */
export interface ReplaceableLine {
  productId: string;
  unitPrice?: number;
  priceMode?: 'catalog' | 'manual' | 'kept';
  unitId?: string | null;
  unitCode?: string | null;
  fromTemplate?: boolean;
  fromSectionTemplate?: boolean;
  isGift?: boolean;
}

/** Whether a line may be swapped for another product. A free gift is worked out again on every save, so it is not the person's line to change. */
export const canReplaceLine = (line: Pick<ReplaceableLine, 'isGift'>): boolean => line.isGift !== true;

/**
 * The same line with another product in it. What describes the place and the deal stays: its position, section, quantity and discount.
 * What belonged to the old product goes:
 * - a typed or saved price (it was for the old item), so the line is priced from the price lists again, showing the new item's
 *   catalogue price until they answer;
 * - the unit (kg, crate), because the new item has its own units, so the line starts in the new item's base unit;
 * - the "came from the template" marks, because swapping was the person's own choice and a later template switch must not undo it.
 */
export function replaceLineProduct<L extends ReplaceableLine>(line: L, product: Pick<CatalogueProduct, 'id' | 'price'>): L {
  const { unitPrice: _old, ...rest } = line;
  return {
    ...rest,
    productId: product.id,
    ...(product.price == null ? {} : { unitPrice: product.price }),
    priceMode: 'catalog',
    unitId: null,
    unitCode: null,
    fromTemplate: false,
    fromSectionTemplate: false,
  } as L;
}

/**
 * The same template line with another product in it. A template line keeps its place, section, quantity and discount; a fixed price was
 * set for the old item, so the line goes back to following the catalogue price until someone fixes a price for the new one.
 */
export function replaceTemplateLineProduct<L extends { productId: string; priceMode: 'catalog' | 'fixed'; unitPrice?: number | null }>(line: L, product: Pick<CatalogueProduct, 'id'>): L {
  return { ...line, productId: product.id, priceMode: 'catalog', unitPrice: null };
}
