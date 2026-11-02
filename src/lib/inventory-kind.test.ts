import { describe, expect, it } from 'vitest';
import {
  inventoryKindOf,
  inventoryKindQuantityProblem,
  inventoryStockLines,
  isInventoryKind,
  isInventoryManaged,
} from './inventory-kind';

describe('operational inventory kind', () => {
  it('defaults legacy or omitted domain objects to Inventory without changing their business classification', () => {
    expect(inventoryKindOf({})).toBe('inventory');
    expect(isInventoryManaged({ inventoryKind: undefined })).toBe(true);
    expect(isInventoryKind('service')).toBe(true);
    expect(isInventoryKind('raw_material')).toBe(false);
  });

  it('allows stock balances only for inventory-managed products', () => {
    expect(
      inventoryKindQuantityProblem('inventory', {
        stockQuantity: 10,
        reservedQuantity: 2,
        lowStockThreshold: 3,
      }),
    ).toBeNull();
    expect(
      inventoryKindQuantityProblem('non_inventory', {
        stockQuantity: 0,
        reservedQuantity: 0,
        lowStockThreshold: 0,
      }),
    ).toBeNull();
    expect(
      inventoryKindQuantityProblem('service', {
        stockQuantity: 1,
        reservedQuantity: 0,
        lowStockThreshold: 0,
      }),
    ).toMatch(/cannot have on-hand or reserved stock/);
    expect(
      inventoryKindQuantityProblem('non_inventory', {
        stockQuantity: 0,
        reservedQuantity: 0,
        lowStockThreshold: 2,
      }),
    ).toMatch(/reorder threshold/);
  });

  it('sends only Inventory lines to stock reservation and delivery-branch availability', () => {
    const lines = [
      { productId: 'stock', quantity: 2 },
      { productId: 'office-supply', quantity: 1 },
      { productId: 'service', quantity: 3 },
    ];
    expect(
      inventoryStockLines(
        lines,
        new Map([
          ['stock', 'inventory'],
          ['office-supply', 'non_inventory'],
          ['service', 'service'],
        ]),
      ),
    ).toEqual([{ productId: 'stock', quantity: 2 }]);
  });
});
