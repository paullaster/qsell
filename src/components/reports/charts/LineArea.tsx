'use client';

import { useId, useMemo, useState } from 'react';
import { areaPath, linePath } from '@/lib/reports/chart/paths';
import { categoricalVar } from '@/lib/reports/chart/palette';
import { bandIndexAt, bandScale, linearScale, niceAxis } from '@/lib/reports/chart/scale';
import { formatters, type Unit } from '@/lib/reports/units';
import { ChartTable, Legend, nextIndex, useChartWidth, type ChartSeries } from './shared';

const PAD = { top: 10, right: 12, bottom: 26, left: 52 };

/** Where a label sits on its tick: the first starts on it, the last ends on it, the rest are centred. */
function anchorFor(index: number, count: number): 'start' | 'middle' | 'end' {
  if (index === 0) return 'start';
  return index === count - 1 ? 'end' : 'middle';
}

/**
 * Lines (and optionally a soft area under the first) over categories such as days. A dashed series is a reference, such
 * as the same days last year. Hover, touch or the arrow keys read out any category; the numbers are also available as a
 * table. A missing value is a gap in the line, never a false zero.
 */
export function LineArea({
  categories,
  series,
  unit,
  ariaLabel,
  categoryLabel = 'Day',
  height = 220,
  area = true,
}: {
  categories: readonly string[];
  series: readonly ChartSeries[];
  unit: Unit;
  ariaLabel: string;
  categoryLabel?: string;
  height?: number;
  area?: boolean;
}) {
  const { value: formatValue, axis: formatAxis } = formatters(unit);
  const [ref, width] = useChartWidth();
  const [active, setActive] = useState<number | null>(null);
  const tipId = useId();
  const n = categories.length;

  const geometry = useMemo(() => {
    const all = series
      .flatMap((s) => s.values)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const axis = niceAxis(Math.min(0, ...all), Math.max(0, ...all), 5);
    const plotW = Math.max(width - PAD.left - PAD.right, 10);
    const plotH = height - PAD.top - PAD.bottom;
    const y = linearScale([axis.min, axis.max], [PAD.top + plotH, PAD.top]);
    const bands = bandScale(Math.max(n, 1), [PAD.left, PAD.left + plotW], 0);
    return { axis, y, bands, plotW, plotH };
  }, [series, width, height, n]);

  if (n === 0) return null;
  const color = (s: ChartSeries, i: number) => categoricalVar(s.slot ?? i);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(geometry.plotW / 70))));
  const baseline = geometry.y(0);
  const first = series[0];

  const onMove = (clientX: number, left: number) =>
    setActive(bandIndexAt(clientX - left + PAD.left, n, [PAD.left, PAD.left + geometry.plotW]));

  return (
    <figure className="space-y-2">
      <Legend series={series} color={color} />
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label={`${ariaLabel}. ${String(n)} points. Use the left and right arrow keys to read each one.`}
        aria-describedby={active === null ? undefined : tipId}
        className="relative rounded-sm focus-visible:outline-2 focus-visible:outline-indigo-500"
        style={{ height }}
        onPointerMove={(e) => {
          onMove(e.clientX, e.currentTarget.getBoundingClientRect().left);
        }}
        onPointerLeave={() => {
          setActive(null);
        }}
        onFocus={() => {
          setActive((i) => i ?? n - 1);
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
          {area && first !== undefined ? (
            <path
              d={areaPath(first.values, geometry.bands.center, geometry.y, baseline)}
              fill={color(first, 0)}
              opacity={0.12}
            />
          ) : null}
          {series.map((s, i) => (
            <path
              key={s.key}
              d={linePath(s.values, geometry.bands.center, geometry.y)}
              fill="none"
              stroke={color(s, i)}
              strokeWidth={s.dashed === true ? 1.75 : 2.5}
              strokeDasharray={s.dashed === true ? '5 4' : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {categories.map((c, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text
                key={`${c}-${String(i)}`}
                x={geometry.bands.center(i)}
                y={height - 8}
                textAnchor={anchorFor(i, n)}
                fontSize="10"
                fill="var(--fg-subtle)"
              >
                {c}
              </text>
            ) : null,
          )}
          {active === null ? null : (
            <g>
              <line
                x1={geometry.bands.center(active)}
                x2={geometry.bands.center(active)}
                y1={PAD.top}
                y2={PAD.top + geometry.plotH}
                stroke="var(--fg-faint)"
                strokeDasharray="3 3"
              />
              {series.map((s, i) => {
                const v = s.values[active];
                return v === null || v === undefined ? null : (
                  <circle
                    key={s.key}
                    cx={geometry.bands.center(active)}
                    cy={geometry.y(v)}
                    r={4}
                    fill="var(--surface)"
                    stroke={color(s, i)}
                    strokeWidth={2}
                  />
                );
              })}
            </g>
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
                        className="inline-block size-2 rounded-full"
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
