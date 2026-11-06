'use client';

import { useState } from 'react';
import type { CatalogueProduct } from '@/lib/catalogue-entry';

/** The last swap, kept so it can be undone in one click. */
export interface Replaced<L> {
  index: number;
  before: L;
  fromName: string;
  toId: string;
  toName: string;
}

/**
 * Swapping the product on a line for another, on any screen that lists lines (a quote, a quote template, a section template).
 * The line keeps its place; what else it keeps is the caller's `swap`. Undo puts the old line back unless the line was changed since.
 */
export function useLineReplace<L extends { productId: string }>({
  lines,
  setLines,
  nameOf,
  swap,
  onTouched,
}: {
  lines: readonly L[];
  setLines: (next: L[]) => void;
  nameOf: (productId: string) => string;
  swap: (line: L, product: CatalogueProduct) => L;
  /** A line was changed by a swap or an undo, so the screen can bring it into view. */
  onTouched?: (index: number) => void;
}) {
  /** The line whose product is being swapped, by position: nothing else can change while the dialog is open. */
  const [replacing, setReplacing] = useState<number | null>(null);
  const [replaced, setReplaced] = useState<Replaced<L> | null>(null);

  const replaceProduct = (index: number, product: CatalogueProduct) => {
    const line = lines[index];
    setReplacing(null);
    if (line === undefined || line.productId === product.id) return;
    setReplaced({ index, before: line, fromName: nameOf(line.productId), toId: product.id, toName: product.name });
    setLines(lines.map((l, i) => (i === index ? swap(l, product) : l)));
    onTouched?.(index);
  };

  const undo = () => {
    const r = replaced;
    setReplaced(null);
    if (r === null || lines[r.index]?.productId !== r.toId) return;
    setLines(lines.map((l, i) => (i === r.index ? r.before : l)));
    onTouched?.(r.index);
  };

  return { replacing, open: setReplacing, close: () => setReplacing(null), replaced, dismiss: () => setReplaced(null), replaceProduct, undo };
}
