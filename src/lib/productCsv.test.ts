import { describe, expect, it } from 'vitest';
import { parseProductRow, resolveHeaders } from './productCsv';

const HEADERS = [
  'SKU',
  'Stock_Code',
  'Name',
  'Category',
  'Inventory_Kind',
  'Cost_Price',
  'Price',
  'Stock_Qty',
  'Low_Stock_Threshold',
  'Unit',
];
const parse = (row: string[]) => {
  const headers = resolveHeaders(HEADERS);
  if (!headers.ok) throw new Error(headers.errors.join(' '));
  return parseProductRow(row, headers.map);
};
const row = (over: Partial<Record<(typeof HEADERS)[number], string>> = {}) => {
  const base: Record<string, string> = {
    SKU: 'F1',
    Stock_Code: 'S1',
    Name: 'Fish',
    Category: 'Food',
    Inventory_Kind: 'inventory',
    Cost_Price: '50',
    Price: '100',
    Stock_Qty: '12.5',
    Low_Stock_Threshold: '2',
    Unit: 'kg',
    ...over,
  };
  return HEADERS.map((h) => base[h] ?? '');
};

describe('the product CSV: unit and decimal stock', () => {
  it('reads the unit code and a stock in decimals', () => {
    const r = parse(row());
    expect(r.ok && r.draft).toMatchObject({
      unitRef: 'kg',
      stockQuantity: 12.5,
      lowStockThreshold: 2,
    });
  });

  it('leaves the unit empty (the default unit) when the column is blank, and knows its aliases', () => {
    expect(parse(row({ Unit: '' }))).toMatchObject({ ok: true, draft: { unitRef: null } });
    expect(resolveHeaders(['SKU', 'Name', 'Category', 'Cost_Price', 'UoM']).ok).toBe(true);
  });

  it('refuses a stock with more than three decimals or a negative one, naming the column', () => {
    for (const bad of ['1.2345', '-1', 'x']) {
      const r = parse(row({ Stock_Qty: bad }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errors[0]?.column).toBe('Stock_Qty');
    }
  });

  it('defaults old templates to inventory and allows services/non-inventory products only with zero stock', () => {
    expect(parse(row({ Inventory_Kind: '' }))).toMatchObject({ ok: true, draft: { inventoryKind: 'inventory' } });
    expect(parse(row({ Inventory_Kind: 'service', Stock_Qty: '0', Low_Stock_Threshold: '0' }))).toMatchObject({ ok: true, draft: { inventoryKind: 'service' } });
    const invalid = parse(row({ Inventory_Kind: 'non_inventory', Stock_Qty: '2' }));
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.errors.map((error) => error.column)).toContain('Stock_Qty');
  });
});
