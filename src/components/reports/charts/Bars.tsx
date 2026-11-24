'use client';

import { useId, useMemo, useState } from 'react';
import { categoricalVar } from '@/lib/reports/chart/palette';
import { bandIndexAt, bandScale, linearScale, niceAxis } from '@/lib/reports/chart/scale';
import { formatters, type Unit } from '@/lib/reports/units';
import { ChartTable, Legend, nextIndex, useChartWidth, type ChartSeries } from './shared';

const PAD = { top: 10, right: 12, bottom: 26, left: 52 };

/**
 * Bars over categories: one bar per series side by side (grouped) or piled on one another (stacked). Bars always start at
 * zero, because a bar that does not is a lie about size. Values below zero hang under the axis.
 */
export function Bars({
  categories,
  series,
  unit,
  ariaLabel,
  categoryLabel = 'Group',
  height = 220,
  stacked = false,
}: {
  categories: readonly string[];
  series: readonly ChartSeries[];
  unit: Unit;
  ariaLabel: string;
  categoryLabel?: string;
  height?: number;
  stacked?: boolean;
}) {
  const { value: formatValue, axis: formatAxis } = formatters(unit);
  const [ref, width] = useChartWidth();
  const [active, setActive] = useState<number | null>(null);
  const tipId = useId();
  const n = categories.length;

  const geometry = useMemo(() => {
    const value = (s: ChartSeries, i: number): number => s.values[i] ?? 0;
    const totals = categories.map((_, i) =>
      stacked
        ? [
            series.reduce((a, s) => a + Math.max(value(s, i), 0), 0),
            series.reduce((a, s) => a + Math.min(value(s, i), 0), 0),
          ]
        : [
            Math.max(0, ...series.map((s) => value(s, i))),
            Math.min(0, ...series.map((s) => value(s, i))),
          ],
    );
    const axis = niceAxis(
      Math.min(0, ...totals.map((t) => t[1] ?? 0)),
      Math.max(0, ...totals.map((t) => t[0] ?? 0)),
      5,
    );
    const plotW = Math.max(width - PAD.left - PAD.right, 10);
    const plotH = height - PAD.top - PAD.bottom;
    const y = linearScale([axis.min, axis.max], [PAD.top + plotH, PAD.top]);
    const bands = bandScale(Math.max(n, 1), [PAD.left, PAD.left + plotW], 0.25);
    return { axis, y, bands, plotW, plotH };
  }, [categories, series, width, height, n, stacked]);

  if (n === 0) return null;
  const color = (s: ChartSeries, i: number) => categoricalVar(s.slot ?? i);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(geometry.plotW / 70))));
  const zero = geometry.y(0);
  const each = stacked ? geometry.bands.width : geometry.bands.width / Math.max(series.length, 1);

  const bars: {
    key: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fill: string;
    faded: boolean;
  }[] = [];
  categories.forEach((_, i) => {
    let up = 0;
    let down = 0;
    series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || v === undefined || v === 0) return;
      const x = stacked ? geometry.bands.start(i) : geometry.bands.start(i) + si * each;
      const stackBase = v >= 0 ? up : down;
      const from = stacked ? stackBase : 0;
      const to = from + v;
      if (stacked) {
        if (v >= 0) up = to;
        else down = to;
      }
      const y0 = geometry.y(Math.max(from, to));
      const y1 = geometry.y(Math.min(from, to));
      bars.push({
        key: `${s.key}-${String(i)}`,
        x,
        y: y0,
        w: Math.max(each - (stacked ? 0 : 2), 1),
        h: Math.max(y1 - y0, 1),
        fill: color(s, si),
        faded: active !== null && active !== i,
      });
    });
  });

  return (
    <figure className="space-y-2">
      {series.length > 1 ? <Legend series={series} color={color} /> : null}
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label={`${ariaLabel}. ${String(n)} groups. Use the left and right arrow keys to read each one.`}
        aria-describedby={active === null ? undefined : tipId}
        className="relative rounded-sm focus-visible:outline-2 focus-visible:outline-indigo-500"
        style={{ height }}
        onPointerMove={(e) => {
          setActive(
            bandIndexAt(e.clientX - e.currentTarget.getBoundingClientRect().left, n, [
              PAD.left,
              PAD.left + geometry.plotW,
            ]),
          );
        }}
        onPointerLeave={() => {
          setActive(null);
        }}
        onFocus={() => {
          setActive((i) => i ?? 0);
        }}
        onBlur={() => {
          setActive(null);
        }}
        onKeyDown={(e) => {
          const next = nextIndex(e.key, active, n);
          if (next === null) return;
          e.preventDefault();
          setActive(next);
        }}
      >
        <svg width={width} height={height} aria-hidden className="block">
          {geometry.axis.ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={geometry.y(t)}
                y2={geometry.y(t)}
                stroke="var(--line)"
                strokeWidth={t === 0 ? 1.5 : 1}
              />
              <text
                x={PAD.left - 8}
                y={geometry.y(t) + 3.5}
                textAnchor="end"
                fontSize="10"
                fill="var(--fg-subtle)"
              >
                {formatAxis(t)}
              </text>
            </g>
          ))}
          {bars.map((b) => (
            <rect
              key={b.key}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={2}
              fill={b.fill}
              opacity={b.faded ? 0.45 : 1}
            />
          ))}
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={zero}
            y2={zero}
            stroke="var(--line-strong)"
          />
          {categories.map((c, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text
                key={`${c}-${String(i)}`}
                x={geometry.bands.center(i)}
                y={height - 8}
                textAnchor="middle"
                fontSize="10"
                fill="var(--fg-subtle)"
              >
                {c}
              </text>
            ) : null,
          )}
        </svg>
        {active === null ? null : (
          <div
            id={tipId}
            role="status"
            className="pointer-events-none absolute top-1 z-10 w-52 rounded-lg border border-line bg-surface-raised p-2.5 text-xs shadow-lg"
            style={{
              left: Math.min(
                Math.max(geometry.bands.center(active), 110),
                Math.max(width - 110, 110),
              ),
              transform: 'translateX(-50%)',
            }}
          >
            <p className="font-semibold text-fg-strong">{categories[active]}</p>
            <ul className="mt-1 space-y-0.5">
              {series.map((s, i) => {
                const v = s.values[active];
                return (
                  <li key={s.key} className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5 text-fg-muted">
                      <span
                        aria-hidden
                        className="inline-block size-2 rounded-sm"
                        style={{ background: color(s, i) }}
                      />
                      {s.label}
                    </span>
                    <span className="font-mono text-fg tabular-nums">
                      {v === null || v === undefined ? '–' : formatValue(v)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
      <ChartTable
        caption={ariaLabel}
        categoryLabel={categoryLabel}
        categories={categories}
        series={series}
        format={formatValue}
      />
    </figure>
  );
}
