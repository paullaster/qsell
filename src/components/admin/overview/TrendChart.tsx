'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { formatLocalDate, formatMoney, formatMoneyShort } from '@/components/admin/overview/format';

interface Point {
  date: string;
  sales: number;
  orders: number;
  previousDate: string;
  previousSales: number;
}

/** A round number at or above `value`, so axis ticks read 0 / 5K / 10K rather than 0 / 4,730 / 9,460. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/**
 * Daily sales as columns with the comparison period drawn as a line over them. Hover, touch or
 * the arrow keys read out any day; a table with every day is available underneath.
 */
export function TrendChart({
  trend,
  currency,
  compareLabel,
}: {
  trend: Point[];
  currency: string;
  compareLabel: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  const max = useMemo(
    () => niceMax(Math.max(...trend.map((d) => d.sales), ...trend.map((d) => d.previousSales), 0)),
    [trend],
  );
  const n = trend.length;
  const hasPrevious = trend.some((d) => d.previousSales > 0);
  if (n === 0) return null;

  const gap = n > 60 ? 'gap-px' : 'gap-0.5';
  const pct = (v: number) => (v / max) * 100;
  const linePoints = trend.map((d, i) => `${i + 0.5},${100 - pct(d.previousSales)}`).join(' ');
  const ticks = [max, max / 2, 0];
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  const indexFromX = (clientX: number): number => {
    const box = plot.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.min(n - 1, Math.max(0, Math.floor(((clientX - box.left) / box.width) * n)));
  };

  const a = active === null ? null : trend[active];
  const delta =
    a && a.previousSales > 0
      ? Number((((a.sales - a.previousSales) / a.previousSales) * 100).toFixed(1))
      : null;

  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-indigo-500" aria-hidden="true" />{' '}
          Sales per day
        </span>
        {hasPrevious ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-fg-subtle" aria-hidden="true" />{' '}
            {compareLabel}
          </span>
        ) : null}
      </figcaption>

      <div className="flex gap-2">
        <div
          className="flex h-48 w-14 shrink-0 flex-col justify-between text-right text-[10px] text-fg-subtle"
          aria-hidden="true"
        >
          {ticks.map((t) => (
            <span key={t}>{t === 0 ? '0' : formatMoneyShort(t, '').trim()}</span>
          ))}
        </div>

        <div
          ref={plot}
          tabIndex={0}
          role="application"
          aria-label={`Daily sales chart, ${n} days. Use left and right arrow keys to read each day.`}
          aria-describedby={active === null ? undefined : tooltipId}
          className="relative h-48 min-w-0 flex-1 rounded-sm focus-visible:outline-2 focus-visible:outline-indigo-500"
          onPointerMove={(e) => setActive(indexFromX(e.clientX))}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((i) => i ?? n - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setActive((i) => Math.max(0, (i ?? n) - 1));
            else if (e.key === 'ArrowRight') setActive((i) => Math.min(n - 1, (i ?? -1) + 1));
            else if (e.key === 'Home') setActive(0);
            else if (e.key === 'End') setActive(n - 1);
            else return;
            e.preventDefault();
          }}
        >
          {/* gridlines */}
          {[0, 50, 100].map((p) => (
            <div
              key={p}
              className="absolute inset-x-0 border-t border-line"
              style={{ top: `${p === 100 ? 99.6 : p}%` }}
              aria-hidden="true"
            />
          ))}

          <div className={`absolute inset-0 flex items-end ${gap}`} aria-hidden="true">
            {trend.map((d, i) => (
              <div key={d.date} className="flex h-full min-w-px flex-1 items-end justify-center">
                <div
                  className={`w-full max-w-6 rounded-t ${active === i ? 'bg-indigo-400' : 'bg-indigo-500'}`}
                  style={{ height: `${d.sales > 0 ? Math.max(pct(d.sales), 1.5) : 0}%` }}
                />
              </div>
            ))}
          </div>

          {hasPrevious ? (
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
              viewBox={`0 0 ${n} 100`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polyline
                points={linePoints}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                className="text-fg-muted"
              />
            </svg>
          ) : null}

          {a && active !== null ? (
            <div
              id={tooltipId}
              role="status"
              className="pointer-events-none absolute top-1 z-10 w-52 rounded-lg border border-line bg-surface-raised p-2.5 text-xs shadow-lg"
              style={{
                left: `${Math.min(Math.max(((active + 0.5) / n) * 100, 14), 86)}%`,
                transform: 'translateX(-50%)',
              }}
            >
              <p className="font-semibold text-fg-strong">{formatLocalDate(a.date)}</p>
              <p className="text-fg">
                {formatMoney(a.sales, currency)} · {a.orders} order{a.orders === 1 ? '' : 's'}
              </p>
              {hasPrevious ? (
                <p className="mt-1 border-t border-line pt-1 text-fg-muted">
                  {formatLocalDate(a.previousDate)}: {formatMoney(a.previousSales, currency)}
                  {delta !== null ? ` (${delta > 0 ? '+' : ''}${delta}%)` : ''}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-[10px] text-fg-subtle" aria-hidden="true">
        {trend.map((d, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <span key={d.date}>{formatLocalDate(d.date).replace(/ \d{4}$/, '')}</span>
          ) : null,
        )}
      </div>

      <details className="text-xs text-fg-muted">
        <summary className="min-h-8 cursor-pointer py-1">View every day as a table</summary>
        <div className="max-h-64 overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              Sales and orders per day, with the comparison period
            </caption>
            <thead className="sticky top-0 bg-surface-raised text-fg-subtle">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Day
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Orders
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Sales
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {compareLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {trend.map((d) => (
                <tr key={d.date} className="border-t border-line">
                  <th scope="row" className="px-3 py-1.5 font-normal text-fg">
                    {formatLocalDate(d.date)}
                  </th>
                  <td className="px-3 py-1.5 text-right tabular-nums">{d.orders}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatMoney(d.sales, currency)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatMoney(d.previousSales, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
