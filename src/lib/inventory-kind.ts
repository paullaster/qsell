/** The product's stock and fulfillment contract; independent of its seller-defined business classification. */
export const INVENTORY_KINDS = ['inventory', 'non_inventory', 'service'] as const;
export type InventoryKind = (typeof INVENTORY_KINDS)[number];

export const INVENTORY_KIND_OPTIONS: readonly {
  id: InventoryKind;
  label: string;
  description: string;
}[] = [
  {
    id: 'inventory',
    label: 'Inventory item',
    description: 'Track on-hand stock, availability, reservations, and stock movements.',
  },
  {
    id: 'non_inventory',
    label: 'Non-inventory item',
    description: 'A good you can buy or sell without stock balances or reservations.',
  },
  {
    id: 'service',
    label: 'Service',
    description: 'A service or time-based offering; never managed as physical stock.',
  },
];

export const isInventoryKind = (value: unknown): value is InventoryKind =>
  typeof value === 'string' && INVENTORY_KINDS.some((kind) => kind === value);

/** Old in-memory/public objects without this field are treated as Inventory for compatibility. */
export const inventoryKindOf = (product: { inventoryKind?: InventoryKind | null }): InventoryKind =>
  product.inventoryKind ?? 'inventory';

export const isInventoryManaged = (product: { inventoryKind?: InventoryKind | null }): boolean =>
  inventoryKindOf(product) === 'inventory';

/** The stock ledger sees only Inventory-kind rows, never commercial service/non-stock lines. */
export function inventoryStockLines<T extends { productId: string; quantity: number }>(
  lines: readonly T[],
  kindsByProduct: ReadonlyMap<string, InventoryKind>,
): T[] {
  return lines.filter((line) => kindsByProduct.get(line.productId) === 'inventory');
}

/** Non-stock kinds cannot carry on-hand, reservations, or reorder thresholds. */
export function inventoryKindQuantityProblem(
  kind: InventoryKind,
  amounts: { stockQuantity: number; reservedQuantity: number; lowStockThreshold: number },
): string | null {
  if (kind === 'inventory') return null;
  if (amounts.stockQuantity !== 0 || amounts.reservedQuantity !== 0) {
    return 'Non-inventory and service products cannot have on-hand or reserved stock.';
  }
  if (amounts.lowStockThreshold !== 0) {
    return 'A reorder threshold is only available for inventory-managed products.';
  }
  return null;
}
