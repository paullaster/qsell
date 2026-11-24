import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { deltaOf } from '@/lib/reports/format';
import { t } from '@/lib/reports/messages';
import { Sparkline } from '../charts/Sparkline';

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The change between this period and the one it is compared with. Direction is shown with an icon and with words, never
 * with colour alone; green or red says whether the change is good (an increase is good for sales, bad for overdue debt).
 */
export function Delta({
  current,
  previous,
  basis,
  upIsGood = true,
}: {
  current: number;
  previous: number;
  /** What it is compared with, in words ("last month"). */
  basis: string;
  upIsGood?: boolean;
}) {
  const d = deltaOf(current, previous);
  if (d.percent === null) {
    return (
      <p className="flex items-center gap-1 text-xs text-fg-subtle" data-testid="delta">
        <Minus className="size-3.5" aria-hidden />
        {capital(t('common.nothing_to_compare'))}
      </p>
    );
  }
  if (d.direction === 'flat') {
    return (
      <p className="flex items-center gap-1 text-xs text-fg-muted" data-testid="delta">
        <Minus className="size-3.5" aria-hidden />
        <span className="font-semibold">{capital(t('common.level_with', { basis }))}</span>
      </p>
    );
  }
  const up = d.direction === 'up';
  const good = up === upIsGood;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const tone = good ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400';
  const words = up
    ? t('common.up_by', { percent: d.percent, basis })
    : t('common.down_by', { percent: d.percent, basis });
  return (
    <p className={`flex items-center gap-1 text-xs ${tone}`} data-testid="delta" data-good={good}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="font-semibold">{capital(words)}</span>
    </p>
  );
}

/**
 * One headline figure: a small label, a large tabular number, how it compares, and an optional trend line. A short form
 * (KES 1.2M) can be shown with the exact figure kept for hover and for screen readers.
 */
export function Kpi({
  label,
  value,
  fullValue,
  note,
  trend,
  hero = false,
  children,
}: {
  label: string;
  value: string;
  fullValue?: string;
  note?: string;
  trend?: readonly number[];
  /** A hero figure is drawn larger: use for the one or two numbers the page exists to show. */
  hero?: boolean;
  children?: React.ReactNode;
}) {
  const shortened = fullValue !== undefined && fullValue !== value;
  return (
    <div
      className="min-w-0 space-y-1.5 rounded-xl border border-line bg-surface p-3.5 sm:p-4"
      data-testid="kpi"
    >
      <p className="text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{label}</p>
      <p
        className={`truncate font-mono font-bold text-fg-strong tabular-nums ${hero ? 'text-3xl sm:text-4xl' : 'text-xl sm:text-2xl'}`}
        title={fullValue}
      >
        {value}
        {shortened ? <span className="sr-only"> ({fullValue})</span> : null}
      </p>
      {children}
      {trend !== undefined ? <Sparkline values={trend} label={`${label} trend`} /> : null}
      {note !== undefined ? <p className="text-[11px] text-fg-subtle">{note}</p> : null}
    </div>
  );
}

/** A row of headline figures that wraps from two columns on a phone to four across on a wide screen. */
export function HeroStrip({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <section aria-label={label} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {children}
    </section>
  );
}
