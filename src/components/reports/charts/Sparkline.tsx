import { linePath } from '@/lib/reports/chart/paths';
import { linearScale } from '@/lib/reports/chart/scale';

/**
 * A small trend line at the full width of its tile. The drawing is a picture of the numbers beside it, so it has a
 * short text description for screen readers rather than a data table of its own. Nothing is drawn for fewer than two
 * points or when every value is the same zero.
 */
export function Sparkline({
  values,
  label,
  color = 'var(--data-1)',
}: {
  values: readonly (number | null)[];
  label: string;
  color?: string;
}) {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (real.length < 2 || real.every((v) => v === 0)) return null;
  const lo = Math.min(...real, 0);
  const hi = Math.max(...real);
  const width = 100;
  const height = 24;
  const x = linearScale([0, values.length - 1], [1, width - 1]);
  const y = linearScale([lo, hi], [height - 2, 2]);
  const first = real[0] ?? 0;
  const last = real.at(-1) ?? 0;
  const words = `${label}: from ${String(first)} to ${String(last)} over ${String(values.length)} points`;
  return (
    <svg
      role="img"
      aria-label={words}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      className="h-6 w-full"
    >
      <path
        d={linePath(values, x, y)}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
