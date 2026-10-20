import { CatalogService } from '@/server/domains/catalog/service';
import { getContainer } from '@/server/di/container';
import { repairLine, type LineRepair, type SavedUnitLine } from '@/lib/quote-unit-repair';

/** A saved line with the product it is for. */
export interface RepairableLine extends SavedUnitLine {
  productId: string | null;
}

/**
 * For each saved quote line, what it needs now that its product's units may have changed (null for none).
 * All the products and their units are read at once, however long the quote is.
 */
export async function repairsFor(lines: readonly RepairableLine[]): Promise<(LineRepair | null)[]> {
  const ids = [
    ...new Set(
      lines.flatMap((l) =>
        l.productId === null || l.enteredQuantity === null ? [] : [l.productId],
      ),
    ),
  ];
  if (ids.length === 0) return lines.map(() => null);
  const [products, packagings] = await Promise.all([
    CatalogService.getProductsByIds(ids),
    getContainer().units.packagingForProducts(ids),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const unitsOf = new Map<string, Map<string, string>>();
  for (const p of packagings) {
    const units = unitsOf.get(p.productId) ?? new Map<string, string>();
    units.set(p.unitId, p.qtyPerBase.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
    unitsOf.set(p.productId, units);
  }
  return lines.map((line) => {
    const product = line.productId === null ? undefined : byId.get(line.productId);
    if (product === undefined || line.productId === null) return null;
    return repairLine(line, {
      name: product.name,
      baseUnitId: product.baseUnitId,
      baseUnitCode: product.baseUnitCode,
      units: unitsOf.get(line.productId) ?? new Map(),
    });
  });
}
