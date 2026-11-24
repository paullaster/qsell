'use client';

import { useEffect, useRef, useState } from 'react';

/** One line or set of bars: a name, a value for every category (null where there is no data), and a colour slot. */
export interface ChartSeries {
  key: string;
  label: string;
  values: readonly (number | null)[];
  /** 0 to 7: which categorical colour. Defaults to the series' position. */
  slot?: number;
  /** A reference line (the comparison period) is drawn dashed. */
  dashed?: boolean;
}

/**
 * The width of an element in pixels, kept current as it changes. Charts are drawn at their real size, so text and
 * strokes stay the same size on a phone and on a wide screen instead of being squeezed with the drawing. Before the
 * first measurement (and where the browser cannot measure) a sensible width is used.
 */
export function useChartWidth(initial = 640): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

/**
 * The same numbers as a table, for people who cannot read a drawing, and for anyone who wants the exact figures. It is a
 * real table, so it can be navigated, read aloud and copied.
 */
export function ChartTable({
  caption,
  categoryLabel,
  categories,
  series,
  format,
}: {
  caption: string;
  categoryLabel: string;
  categories: readonly string[];
  series: readonly ChartSeries[];
  format: (value: number) => string;
}) {
  return (
    <details className="text-xs text-fg-muted">
      <summary className="min-h-10 cursor-pointer py-2 select-none">View as a table</summary>
      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        <table className="w-full table-fixed text-left text-xs break-words">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-surface-raised text-fg-subtle">
            <tr>
              <th scope="col" className="px-2 py-2 font-medium sm:px-3">
                {categoryLabel}
              </th>
              {series.map((s) => (
                <th key={s.key} scope="col" className="px-2 py-2 text-right font-medium sm:px-3">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c, i) => (
              <tr key={`${c}-${String(i)}`} className="border-t border-line">
                <th scope="row" className="px-2 py-1.5 font-normal text-fg sm:px-3">
                  {c}
                </th>
                {series.map((s) => {
                  const v = s.values[i];
                  return (
                    <td key={s.key} className="px-2 py-1.5 text-right tabular-nums sm:px-3">
                      {v === null || v === undefined ? '–' : format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** The key under a chart: a swatch and a name for every series, dashed for a reference line. */
export function Legend({
  series,
  color,
}: {
  series: readonly ChartSeries[];
  color: (s: ChartSeries, index: number) => string;
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
      {series.map((s, i) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={`inline-block ${s.dashed === true ? 'h-0 w-4 border-t-2 border-dashed' : 'size-2.5 rounded-sm'}`}
            style={s.dashed === true ? { borderColor: color(s, i) } : { background: color(s, i) }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Left and right arrow keys, Home and End move through the categories. Returns the next index, or null for another key. */
export function nextIndex(key: string, current: number | null, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowLeft') return Math.max(0, (current ?? count) - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, (current ?? -1) + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
