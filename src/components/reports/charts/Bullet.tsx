import { formatters, type Unit } from '@/lib/reports/units';

/** How far an actual figure has got towards a target, as a share (0 when there is no target to compare with). */
export function attainment(actual: number, target: number): number | null {
  if (!Number.isFinite(actual) || !Number.isFinite(target) || target <= 0) return null;
  return Math.round((actual / target) * 1000) / 10;
}

/** The state of an attainment: on track, close, or behind. The thresholds are shares of the target, set by the caller. */
export function attainmentState(
  percent: number | null,
  amber = 70,
  green = 100,
): 'none' | 'behind' | 'close' | 'met' {
  if (percent === null) return 'none';
  if (percent >= green) return 'met';
  if (percent >= amber) return 'close';
  return 'behind';
}

const STATE_WORDS = {
  none: 'No target set',
  behind: 'Behind target',
  close: 'Close to target',
  met: 'Target met',
} as const;
const STATE_TONE = {
  none: 'bg-fg-faint',
  behind: 'bg-red-700 dark:bg-red-400',
  close: 'bg-amber-600 dark:bg-amber-400',
  met: 'bg-emerald-700 dark:bg-emerald-400',
} as const;

/**
 * Actual against target on one bar, with the target as a tick. The state is written in words beside the bar, so colour is
 * never the only signal. A bar beyond the target is shown full with the share written out.
 */
export function Bullet({
  label,
  actual,
  target,
  unit,
  amberFrom = 70,
  greenFrom = 100,
}: {
  label: string;
  actual: number;
  target: number | null;
  unit: Unit;
  amberFrom?: number;
  greenFrom?: number;
}) {
  const formatValue = formatters(unit).value;
  const percent = target === null ? null : attainment(actual, target);
  const state = attainmentState(percent, amberFrom, greenFrom);
  const fill = percent === null ? 0 : Math.min(percent, 100);
  return (
    <div className="space-y-1.5" data-testid="bullet" data-state={state}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold text-fg-strong">{label}</span>
        <span className="font-mono text-fg tabular-nums">
          {formatValue(actual)}
          {target === null ? null : (
            <span className="text-fg-subtle"> / {formatValue(target)}</span>
          )}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill)}
        aria-valuetext={
          percent === null
            ? STATE_WORDS.none
            : `${String(percent)}% of target. ${STATE_WORDS[state]}`
        }
        className="relative h-3 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className={`h-full rounded-full ${STATE_TONE[state]}`}
          style={{ width: `${String(fill)}%` }}
        />
        {target === null ? null : (
          <div aria-hidden className="absolute inset-y-0 right-0 w-0.5 bg-fg-strong" />
        )}
      </div>
      <p className="text-xs text-fg-muted">
        {percent === null
          ? STATE_WORDS.none
          : `${String(percent)}% of target · ${STATE_WORDS[state]}`}
      </p>
    </div>
  );
}
