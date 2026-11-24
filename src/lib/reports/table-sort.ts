export type SortDirection = 'asc' | 'desc';
export type SortableCell = string | number | null;

/**
 * Sorts rows by one column without changing the order of equal rows (a stable sort), so a table does not shuffle when the
 * same column is sorted twice. Empty cells always go last, whichever way the column is sorted. Numbers sort as numbers and
 * text sorts in the person's language with numbers inside it in numeric order ("Shop 2" before "Shop 10").
 */
export function sortRows<T>(
  rows: readonly T[],
  cellOf: (row: T) => SortableCell,
  direction: SortDirection,
  locale = 'en-KE',
): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, cell: cellOf(row) }))
    .sort((a, b) => {
      const aEmpty = a.cell === null || a.cell === '';
      const bEmpty = b.cell === null || b.cell === '';
      if (aEmpty || bEmpty) {
        if (aEmpty && bEmpty) return a.index - b.index;
        return aEmpty ? 1 : -1;
      }
      let order: number;
      if (typeof a.cell === 'number' && typeof b.cell === 'number') order = a.cell - b.cell;
      else order = collator.compare(String(a.cell), String(b.cell));
      return order === 0 ? a.index - b.index : order * sign;
    })
    .map((x) => x.row);
}

/** What the next click on a column header does: unsorted goes ascending, ascending goes descending, descending clears. */
export function nextSort(
  current: { column: number; direction: SortDirection } | null,
  column: number,
): { column: number; direction: SortDirection } | null {
  if (current?.column !== column) return { column, direction: 'asc' };
  return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}
