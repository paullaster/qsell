// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogueProduct } from '@/lib/catalogue-entry';
import { replaceTemplateLineProduct } from '@/lib/quote-replace';
import { useLineReplace } from './useLineReplace';

type Line = { productId: string; quantity: number; priceMode: 'catalog' | 'fixed'; unitPrice?: number | null; discountPercent: number };
const product = (id: string, name: string) => ({ id, name }) as CatalogueProduct;
const start: Line[] = [
  { productId: 'a', quantity: 2, priceMode: 'fixed', unitPrice: 50, discountPercent: 0 },
  { productId: 'b', quantity: 1, priceMode: 'catalog', discountPercent: 10 },
];

/** A tiny host that keeps the lines the way a screen does, so a swap and an undo see each other's result. */
function host(onTouched?: (index: number) => void) {
  return renderHook(() => {
    const [lines, setLines] = useState(start);
    const swap = useLineReplace<Line>({ lines, setLines, nameOf: (id) => `Item ${id}`, swap: replaceTemplateLineProduct, onTouched });
    return { lines, setLines, swap };
  });
}

describe('useLineReplace', () => {
  it('swaps the product on one line only, and remembers what it replaced', () => {
    const { result } = host();
    act(() => result.current.swap.open(0));
    expect(result.current.swap.replacing).toBe(0);
    act(() => result.current.swap.replaceProduct(0, product('c', 'Item c')));
    expect(result.current.lines[0]).toMatchObject({ productId: 'c', quantity: 2, priceMode: 'catalog', unitPrice: null });
    expect(result.current.lines[1]).toEqual(start[1]);
    expect(result.current.swap.replacing).toBeNull();
    expect(result.current.swap.replaced).toMatchObject({ index: 0, fromName: 'Item a', toName: 'Item c' });
  });

  it('puts the old line back on undo', () => {
    const { result } = host();
    act(() => result.current.swap.replaceProduct(0, product('c', 'Item c')));
    act(() => result.current.swap.undo());
    expect(result.current.lines).toEqual(start);
    expect(result.current.swap.replaced).toBeNull();
  });

  it('does nothing when the same product is chosen again', () => {
    const { result } = host();
    act(() => result.current.swap.replaceProduct(1, product('b', 'Item b')));
    expect(result.current.lines).toEqual(start);
    expect(result.current.swap.replaced).toBeNull();
  });

  it('undoes only the latest swap', () => {
    const { result } = host();
    act(() => result.current.swap.replaceProduct(0, product('c', 'Item c')));
    act(() => result.current.swap.replaceProduct(0, product('d', 'Item d')));
    act(() => result.current.swap.undo());
    expect(result.current.lines[0]?.productId).toBe('c');
  });

  it('does not undo over a line that was changed since', () => {
    const { result } = host();
    act(() => result.current.swap.replaceProduct(0, product('c', 'Item c')));
    // Someone changed the line to another product by hand: there is nothing safe to put back.
    act(() => result.current.setLines(result.current.lines.map((l, i) => (i === 0 ? { ...l, productId: 'z' } : l))));
    act(() => result.current.swap.undo());
    expect(result.current.lines[0]?.productId).toBe('z');
  });

  it('tells the screen which line it touched', () => {
    const touched = vi.fn();
    const { result } = host(touched);
    act(() => result.current.swap.replaceProduct(1, product('c', 'Item c')));
    act(() => result.current.swap.undo());
    expect(touched).toHaveBeenNthCalledWith(1, 1);
    expect(touched).toHaveBeenNthCalledWith(2, 1);
  });
});
