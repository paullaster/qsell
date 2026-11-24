import { arcPath, sliceAngles } from '@/lib/reports/chart/paths';
import { categoricalVar } from '@/lib/reports/chart/palette';
import { formatters, type Unit } from '@/lib/reports/units';

export interface DonutItem {
  key: string;
  label: string;
  value: number;
}

const MAX_SLICES = 6;

/** The biggest few, with everything smaller folded into one "Other", so a donut never becomes confetti. */
export function foldSmall(items: readonly DonutItem[], max = MAX_SLICES): DonutItem[] {
  const real = items
    .filter((i) => Number.isFinite(i.value) && i.value > 0)
    .sort((a, b) => b.value - a.value);
  if (real.length <= max) return real;
  const head = real.slice(0, max - 1);
  const rest = real.slice(max - 1).reduce((a, i) => a + i.value, 0);
  return [...head, { key: 'other', label: 'Other', value: rest }];
}

/**
 * A share of a whole, for a handful of parts (payment methods, order outcomes). The legend beside it carries the exact
 * figures and shares, so the drawing is never the only way to read it. Use a bar chart when there are more than six.
 */
export function Donut({
  items,
  unit,
  centerLabel,
  ariaLabel,
}: {
  items: readonly DonutItem[];
  unit: Unit;
  centerLabel: string;
  ariaLabel: string;
}) {
  const formatValue = formatters(unit).value;
  const parts = foldSmall(items);
  const slices = sliceAngles(parts.map((p) => p.value));
  const total = parts.reduce((a, p) => a + p.value, 0);
  const size = 160;
  const c = size / 2;
  return (
    <figure className="flex flex-wrap items-center gap-5" data-testid="donut">
      <svg
        role="img"
        aria-label={`${ariaLabel}: ${parts.map((p) => `${p.label} ${formatValue(p.value)}`).join(', ')}`}
        width={size}
        height={size}
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        className="shrink-0"
      >
        {slices.length === 0 ? (
          <circle cx={c} cy={c} r={58} fill="none" stroke="var(--line)" strokeWidth={22} />
        ) : null}
        {slices.map((s) => (
          <path
            key={parts[s.index]?.key ?? s.index}
            d={arcPath(c, c, 47, 69, s.from, s.to)}
            fill={categoricalVar(s.index)}
            stroke="var(--surface-raised)"
            strokeWidth={1.5}
          />
        ))}
        <text
          x={c}
          y={c - 2}
          textAnchor="middle"
          fontSize="15"
          fontWeight="700"
          fill="var(--fg-strong)"
          className="tabular-nums"
        >
          {formatValue(total)}
        </text>
        <text x={c} y={c + 14} textAnchor="middle" fontSize="10" fill="var(--fg-subtle)">
          {centerLabel}
        </text>
      </svg>
      <figcaption className="min-w-0 flex-1">
        <ul className="space-y-1.5 text-sm">
          {parts.map((p, i) => (
            <li key={p.key} className="flex items-center justify-between gap-3">
              <span className="inline-flex min-w-0 items-center gap-2 text-fg">
                <span
                  aria-hidden
                  className="inline-block size-2.5 shrink-0 rounded-sm"
                  style={{ background: categoricalVar(i) }}
                />
                <span className="truncate">{p.label}</span>
              </span>
              <span className="shrink-0 font-mono text-fg-strong tabular-nums">
                {formatValue(p.value)}
                <span className="ml-2 text-xs text-fg-subtle">
                  {total === 0 ? '0' : String(Math.round((p.value / total) * 1000) / 10)}%
                </span>
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
