import Link from 'next/link';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus, OctagonAlert } from 'lucide-react';
import type { Comparison } from '@/server/domains/reports/types';

export function Card({
  title,
  definition,
  children,
  id,
}: {
  title: string;
  /** One plain sentence saying exactly what the numbers mean. */
  definition?: string;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className="min-w-0 space-y-4 rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
    >
      <div>
        <h2 id={id} className="text-sm font-bold text-fg-strong">
          {title}
        </h2>
        {definition ? <p className="mt-0.5 text-xs text-fg-muted">{definition}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Change against the previous period. Direction is shown with an icon and words, not colour alone. */
export function Delta({
  value,
  previousLabel,
  upIsGood = true,
}: {
  value: Comparison;
  previousLabel: string;
  upIsGood?: boolean;
}) {
  if (value.changePct === null) {
    return (
      <p className="flex items-center gap-1 text-xs text-fg-subtle">
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
        Nothing to compare with in {previousLabel}
      </p>
    );
  }
  const up = value.changePct > 0;
  const flat = value.changePct === 0;
  const good = flat ? null : up === upIsGood;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const tone = flat
    ? 'text-fg-muted'
    : good
      ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-red-700 dark:text-red-400';
  const words = flat ? 'No change' : `${up ? 'Up' : 'Down'} ${Math.abs(value.changePct)}%`;
  return (
    <p className={`flex flex-wrap items-center gap-x-1 text-xs ${tone}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="font-semibold">{words}</span>
      <span className="text-fg-subtle">vs {previousLabel}</span>
    </p>
  );
}

/** A tiny trend line, drawn at the full width of its tile. Decorative: the numbers carry the meaning. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${i},${24 - (v / max) * 22}`).join(' ');
  return (
    <svg
      viewBox={`0 0 ${values.length - 1} 24`}
      preserveAspectRatio="none"
      className="h-6 w-full text-indigo-500"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Kpi({
  label,
  value,
  fullValue,
  note,
  spark,
  children,
}: {
  label: string;
  value: string;
  /** The exact figure, shown on hover and read by screen readers when `value` is abbreviated. */
  fullValue?: string;
  note?: string;
  spark?: number[];
  children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1 rounded-lg border border-line bg-surface p-3.5">
      <p className="text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{label}</p>
      <p className="truncate text-xl font-bold text-fg-strong sm:text-2xl" title={fullValue}>
        {value}
        {fullValue && fullValue !== value ? <span className="sr-only"> ({fullValue})</span> : null}
      </p>
      {children}
      {spark ? <Sparkline values={spark} /> : null}
      {note ? <p className="text-[11px] text-fg-subtle">{note}</p> : null}
    </div>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-fg-muted">
      {children}
    </p>
  );
}

export function SectionFailed({ name }: { name: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-800 bg-red-50 px-3 py-3 text-sm text-red-800"
    >
      <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{name} could not be loaded just now. Refresh the page to try again.</span>
    </p>
  );
}

export function AttentionList({
  items,
}: {
  items: {
    key: string;
    label: string;
    count: number;
    href: string;
    tone: 'critical' | 'warning';
  }[];
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm text-fg-muted">
        Nothing needs your attention right now.
      </p>
    );
  }
  return (
    <section aria-labelledby="attention-heading" className="space-y-2">
      <h2 id="attention-heading" className="text-sm font-bold text-fg-strong">
        Needs your attention
      </h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className={`flex min-h-12 items-center gap-3 rounded-lg border px-3 py-2 text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 ${
                item.tone === 'critical'
                  ? 'border-red-800 bg-red-50/60'
                  : 'border-amber-700 bg-amber-50/60'
              }`}
            >
              <AlertTriangle
                className={`h-4 w-4 shrink-0 ${item.tone === 'critical' ? 'text-red-700' : 'text-amber-700'}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 text-fg-strong">{item.label}</span>
              <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs font-bold text-fg-strong">
                {item.count.toLocaleString('en-KE')}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
