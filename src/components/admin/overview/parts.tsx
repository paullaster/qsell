import Link from 'next/link';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { Comparison } from '@/server/domains/reports/types';
import { Delta as KitDelta, Kpi as KitKpi } from '@/components/reports/kit/Hero';
import { EmptyPanel, FailedPanel, Panel } from '@/components/reports/kit/Panel';

/**
 * The overview's building blocks, now drawn by the shared report kit (`components/reports/kit`). These thin wrappers keep the
 * overview's own call sites simple: they translate the overview's data shapes into the kit's, and add nothing of their own.
 */

export function Card({
  title,
  definition,
  children,
  id,
  more,
}: {
  title: string;
  /** Where the full report for this panel is: the same period, comparison and branch carry over. */
  more?: { href: string; label: string };
  /** One plain sentence saying exactly what the numbers mean. */
  definition?: string;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <Panel
      id={id}
      title={title}
      {...(definition === undefined ? {} : { definition })}
      {...(more === undefined ? {} : { actions: <MoreLink more={more} /> })}
    >
      {children}
    </Panel>
  );
}

/** The "see the full report" link on a panel or a list. */
export function MoreLink({ more }: { more: { href: string; label: string } }) {
  return (
    <Link
      href={more.href}
      className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-indigo-700 hover:bg-hover hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
    >
      {more.label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
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
  return (
    <KitDelta
      current={value.current}
      previous={value.previous}
      basis={previousLabel}
      upIsGood={upIsGood}
    />
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
    <KitKpi
      label={label}
      value={value}
      {...(fullValue === undefined ? {} : { fullValue })}
      {...(note === undefined ? {} : { note })}
      {...(spark === undefined ? {} : { trend: spark })}
    >
      {children}
    </KitKpi>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <EmptyPanel>{children}</EmptyPanel>;
}

export function SectionFailed({ name }: { name: string }) {
  return <FailedPanel name={name} />;
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
