import { roundQty } from '@/lib/decimal';
import { has } from '@/lib/values';

/**
 * A saved quote line keeps the unit it was entered in (3 crates) and the conversion it had then. The product's
 * units can change afterwards. This says what to do with such a line when the quote is opened again, so saving
 * it does not fail on a unit the product no longer has. Pure.
 */

export interface SavedUnitLine {
  /** What the line was entered in; null for a line in the base unit. */
  unitId: string | null;
  unitCode: string | null;
  enteredQuantity: number | null;
  /** Base units in one of that unit, when the line was saved. */
  qtyPerUnit: string | null;
  /** The saved quantity in base units, and the price per base unit. */
  quantity: number;
  unitPrice: number;
}

export interface ProductNow {
  name: string;
  baseUnitId: string;
  baseUnitCode: string;
  /** The units the product is sold in now, with the base units in one of each. */
  units: ReadonlyMap<string, string>;
}

export interface LineRepair {
  kind: 'switched_to_base' | 'size_changed';
  /** In words for the person. */
  message: string;
  /** For `switched_to_base`: what the line becomes, with the same total. */
  to?: { quantity: number; unitPrice: number; unitId: string; unitCode: string };
}

const same = (a: string, b: string): boolean => Number(a) === Number(b);

/** What, if anything, a saved line needs now that the product's units may have changed. */
export function repairLine(saved: SavedUnitLine, product: ProductNow): LineRepair | null {
  if (saved.enteredQuantity === null || !has(saved.unitId) || saved.unitId === product.baseUnitId)
    return null;
  const code = saved.unitCode ?? 'The unit';
  const now = product.units.get(saved.unitId);
  if (now === undefined) {
    const quantity = roundQty(saved.quantity);
    return {
      kind: 'switched_to_base',
      message: `${product.name} is no longer sold in ${code}. This line now shows ${String(quantity)} ${product.baseUnitCode} at ${String(saved.unitPrice)} each, which comes to the same total.`,
      to: {
        quantity,
        unitPrice: saved.unitPrice,
        unitId: product.baseUnitId,
        unitCode: product.baseUnitCode,
      },
    };
  }
  if (saved.qtyPerUnit !== null && !same(saved.qtyPerUnit, now)) {
    return {
      kind: 'size_changed',
      message: `${code} of ${product.name} now holds ${now} ${product.baseUnitCode} (it held ${saved.qtyPerUnit} when this line was made). Saving works the line out with the new size.`,
    };
  }
  return null;
}
