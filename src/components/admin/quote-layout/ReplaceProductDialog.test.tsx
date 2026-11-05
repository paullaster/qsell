// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildCatalogueIndex, type CatalogueProduct } from '@/lib/catalogue-entry';
import { ReplaceProductDialog } from './ReplaceProductDialog';

const product = (id: string, name: string, over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  id, sku: `SKU-${id}`, stockCode: `SC-${id}`, name, category: 'Pantry', brand: null, isSellable: true, inventoryKind: 'stocked',
  price: 10, costPrice: 5, taxRate: 0, isTaxInclusive: true, stockQuantity: 9, reservedQuantity: 1, imageUrl: '',
  baseUnitId: 'u', baseUnitCode: 'pc', baseUnitName: 'Piece', ...over,
} as CatalogueProduct);

const index = buildCatalogueIndex([product('a', 'Rice 5kg'), product('b', 'Flour 2kg'), product('c', 'Salt 500g')]);

function show(over: { onChoose?: (p: CatalogueProduct) => void; onHere?: (id: string) => number | null } = {}) {
  const onChoose = over.onChoose ?? vi.fn();
  render(<ReplaceProductDialog index={index} currency="KES" current={{ id: 'a', name: 'Rice 5kg' }} onHere={over.onHere ?? (() => null)} onChoose={onChoose} onClose={vi.fn()} />);
  return onChoose;
}

afterEach(cleanup);

describe('ReplaceProductDialog', () => {
  it('offers every other product and never the one being replaced', () => {
    show();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByText('Rice 5kg', { selector: 'span' })).toBeNull();
  });
  it('narrows by what is typed and says when nothing matches', () => {
    show();
    const search = screen.getByRole('combobox');
    fireEvent.change(search, { target: { value: 'salt' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('No available product matches');
  });
  it('chooses with a click', () => {
    const onChoose = show();
    fireEvent.click(screen.getByText('Salt 500g'));
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  });
  it('chooses with the arrow keys and Enter', () => {
    const onChoose = show();
    const search = screen.getByRole('combobox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  });
  it('shows what the quote already holds of a product', () => {
    show({ onHere: (id) => (id === 'b' ? 4 : null) });
    expect(screen.getByText('Already on this quote: 4')).toBeTruthy();
  });
});
