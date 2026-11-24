import Link from 'next/link';
import { categoricalVar, colorSlotFor } from '@/lib/reports/chart/palette';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { AppImage } from '@/components/ui/AppImage';
import { formatters, type Unit } from '@/lib/reports/units';

export interface RankedItem {
  key: string;
  label: string;
  value: number;
  /** A second line under the name: units sold, a code, a branch. */
  note?: string;
  /** A picture; without one the item shows its initials on its own stable colour. */
  imageUrl?: string;
  /** The change against the comparison, as a percentage. null when there is nothing to compare with. */
  changePct?: number | null;
  href?: string;
}

const initials = (text: string): string =>
  text
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');

/**
 * The best (or worst) first: a row for each, with a picture or initials, the name, a bar drawn to scale and the figure.
 * Bars are scaled to the largest value, start at zero and are never truncated. The list is a real list, so it reads
 * in order to a screen reader, and each row can link to its detail.
 */
export function RankedBars({
  items,
  unit,
  ariaLabel,
  limit = 10,
}: {
  items: readonly RankedItem[];
  unit: Unit;
  ariaLabel: string;
  limit?: number;
}) {
  const formatValue = formatters(unit).value;
  const shown = items.slice(0, limit);
  const max = Math.max(...shown.map((i) => Math.abs(i.value)), 0);
  return (
    <ol aria-label={ariaLabel} className="space-y-2" data-testid="ranked-bars">
      {shown.map((item, index) => {
        const slot = colorSlotFor(item.key);
        const share = max === 0 ? 0 : (Math.abs(item.value) / max) * 100;
        const row = (
          <>
            <span className="w-5 shrink-0 text-right text-xs font-semibold text-fg-subtle tabular-nums">
              {index + 1}
            </span>
            <span
              aria-hidden
              className="relative inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-xs font-bold text-white"
              style={{ background: categoricalVar(slot) }}
            >
              {item.imageUrl === undefined ? (
                initials(item.label)
              ) : (
                <AppImage src={item.imageUrl} alt="" fill sizes="36px" className="object-cover" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold text-fg-strong">{item.label}</span>
                <span className="shrink-0 font-mono text-sm font-bold text-fg-strong tabular-nums">
                  {formatValue(item.value)}
                </span>
              </span>
              <span className="mt-1 block h-2 overflow-hidden rounded-full bg-surface-sunken">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${String(share)}%`, background: categoricalVar(slot) }}
                />
              </span>
              <span className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
                <span className="truncate">{item.note ?? ''}</span>
                {item.changePct === undefined || item.changePct === null ? null : (
                  <span
                    className={`inline-flex shrink-0 items-center gap-0.5 font-semibold ${item.changePct >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}
                  >
                    {item.changePct >= 0 ? (
                      <ArrowUpRight className="size-3" aria-hidden />
                    ) : (
                      <ArrowDownRight className="size-3" aria-hidden />
                    )}
                    {item.changePct >= 0 ? 'Up' : 'Down'} {Math.abs(item.changePct)}%
                  </span>
                )}
              </span>
            </span>
          </>
        );
        return (
          <li key={item.key}>
            {item.href === undefined ? (
              <div className="flex min-h-11 items-center gap-3">{row}</div>
            ) : (
              <Link
                href={item.href}
                className="-mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                {row}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}
