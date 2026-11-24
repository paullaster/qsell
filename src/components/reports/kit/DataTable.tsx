'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import { nextSort, sortRows, type SortDirection } from '@/lib/reports/table-sort';
import { formatCell } from '@/lib/reports/units';
import type { ColumnKind } from '@/server/domains/reports/export/table';

export type TableCell = string | number | null;

export interface TableColumn {
  label: string;
  kind: ColumnKind;
}

export interface TableRow {
  id: string;
  cells: readonly TableCell[];
  /** Where Enter or a click on the row goes (the next level, or the document). */
  href?: string;
}

const rightAligned = (kind: ColumnKind): boolean => kind !== 'text' && kind !== 'date';

/**
 * A report table. Columns sort by their header (first click ascending, second descending, third clears). The header and the
 * first column stay in view while scrolling; on a phone each row becomes a card, because a wide table on a narrow screen is
 * a poor way to read. Rows that lead somewhere are links, so Enter drills in, and the up and down arrow keys move between
 * rows. Numbers are right aligned in tabular digits so a column lines up. A totals row is drawn apart and in bold.
 */
export function DataTable({
  caption,
  columns,
  rows,
  totals,
  emptyMessage,
}: {
  caption: string;
  columns: readonly TableColumn[];
  rows: readonly TableRow[];
  totals?: readonly TableCell[];
  emptyMessage: string;
}) {
  const format = (cell: TableCell, column: TableColumn): string => formatCell(cell, column.kind);
  const [sort, setSort] = useState<{ column: number; direction: SortDirection } | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);

  const shown = useMemo(
    () =>
      sort === null ? rows : sortRows(rows, (r) => r.cells[sort.column] ?? null, sort.direction),
    [rows, sort],
  );

  if (rows.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-fg-muted"
        data-testid="empty-table"
      >
        {emptyMessage}
      </p>
    );
  }

  const ariaSort = (i: number): 'ascending' | 'descending' | 'none' => {
    if (sort?.column !== i) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  };

  const moveFocus = (current: HTMLElement, delta: number) => {
    const items = Array.from(body.current?.querySelectorAll<HTMLElement>('[data-row-focus]') ?? []);
    const at = items.indexOf(current);
    items[at + delta]?.focus();
  };

  return (
    <div data-testid="data-table">
      {/* Phones: one card per row. */}
      <ul className="space-y-2 md:hidden" aria-label={caption}>
        {shown.map((row) => {
          const [title, ...rest] = row.cells;
          const inner = (
            <>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-fg-strong">
                  {format(title ?? null, columns[0] ?? { label: '', kind: 'text' })}
                </span>
                {row.href === undefined ? null : (
                  <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                )}
              </span>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {rest.map((cell, i) => {
                  const column = columns[i + 1];
                  if (column === undefined) return null;
                  return (
                    <div key={column.label} className="min-w-0">
                      <dt className="truncate text-fg-subtle">{column.label}</dt>
                      <dd className="truncate font-mono text-fg tabular-nums">
                        {format(cell, column)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </>
          );
          return (
            <li key={row.id}>
              {row.href === undefined ? (
                <div className="rounded-xl border border-line bg-surface p-3">{inner}</div>
              ) : (
                <Link
                  href={row.href}
                  className="block rounded-xl border border-line bg-surface p-3 focus-visible:outline-2 focus-visible:outline-indigo-500 active:scale-[0.99]"
                >
                  {inner}
                </Link>
              )}
            </li>
          );
        })}
        {totals === undefined ? null : (
          <li className="rounded-xl border border-line-strong bg-surface-sunken p-3 text-xs">
            <p className="text-sm font-bold text-fg-strong">
              {format(totals[0] ?? null, columns[0] ?? { label: '', kind: 'text' })}
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              {totals.slice(1).map((cell, i) => {
                const column = columns[i + 1];
                if (column === undefined || cell === null) return null;
                return (
                  <div key={column.label}>
                    <dt className="text-fg-subtle">{column.label}</dt>
                    <dd className="font-mono font-bold text-fg-strong tabular-nums">
                      {format(cell, column)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </li>
        )}
      </ul>

      {/* From a tablet up: a table that fits its width and wraps its text. Only its height scrolls. */}
      <div className="hidden max-h-[32rem] overflow-x-clip overflow-y-auto rounded-xl border border-line md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-20 bg-surface-raised">
            <tr>
              {columns.map((column, i) => (
                <th
                  key={column.label}
                  scope="col"
                  aria-sort={ariaSort(i)}
                  className={`border-b border-line px-2 py-2 text-xs font-semibold text-fg-subtle lg:px-3 ${i === 0 ? 'sticky left-0 z-30 bg-surface-raised text-left' : ''} ${rightAligned(column.kind) ? 'text-right' : 'text-left'}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSort((s) => nextSort(s, i));
                    }}
                    className={`inline-flex min-h-9 items-center gap-1 rounded hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500 ${rightAligned(column.kind) ? 'flex-row-reverse' : ''}`}
                  >
                    {column.label}
                    <SortIcon active={sort?.column === i} direction={sort?.direction} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={body}>
            {shown.map((row) => (
              <tr
                key={row.id}
                className="group border-b border-line last:border-b-0 hover:bg-hover"
              >
                {row.cells.map((cell, i) => {
                  const column = columns[i];
                  if (column === undefined) return null;
                  const text = format(cell, column);
                  const first = i === 0;
                  const content =
                    first && row.href !== undefined ? (
                      <Link
                        href={row.href}
                        data-row-focus
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            moveFocus(e.currentTarget, 1);
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            moveFocus(e.currentTarget, -1);
                          }
                        }}
                        className="font-semibold text-fg-strong underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
                      >
                        {text}
                      </Link>
                    ) : (
                      text
                    );
                  return first ? (
                    <th
                      key={column.label}
                      scope="row"
                      className="sticky left-0 z-10 bg-surface px-2 py-2 text-left font-normal text-fg group-hover:bg-hover lg:px-3"
                    >
                      {content}
                    </th>
                  ) : (
                    <td
                      key={column.label}
                      className={`px-2 py-2 lg:px-3 ${rightAligned(column.kind) ? 'text-right font-mono tabular-nums' : 'text-left'} text-fg`}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {totals === undefined ? null : (
            <tfoot className="sticky bottom-0 bg-surface-sunken">
              <tr className="border-t-2 border-line-strong">
                {totals.map((cell, i) => {
                  const column = columns[i];
                  if (column === undefined) return null;
                  return i === 0 ? (
                    <th
                      key={column.label}
                      scope="row"
                      className="sticky left-0 bg-surface-sunken px-2 py-2 text-left font-bold text-fg-strong lg:px-3"
                    >
                      {format(cell, column)}
                    </th>
                  ) : (
                    <td
                      key={column.label}
                      className={`px-2 py-2 font-bold text-fg-strong lg:px-3 ${rightAligned(column.kind) ? 'text-right font-mono tabular-nums' : 'text-left'}`}
                    >
                      {cell === null ? '' : format(cell, column)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

/** The arrow beside a sorted column's name, or nothing when the column is not the one sorted. */
function SortIcon({
  active,
  direction,
}: {
  active: boolean;
  direction: SortDirection | undefined;
}) {
  if (!active) return null;
  return direction === 'asc' ? (
    <ArrowUp className="size-3" aria-hidden />
  ) : (
    <ArrowDown className="size-3" aria-hidden />
  );
}
