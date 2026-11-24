'use client';

import { Suspense, use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Download, Star } from 'lucide-react';
import { searchReports } from '@/lib/reports/search';
import type { ListReportsResult, ReportListItem } from '@/server/domains/reports/actions';
import { useFavourites } from './useFavourites';
import { CommandPalette } from '../kit/CommandPalette';
import { EmptyPanel, FailedPanel, PanelSkeleton } from '../kit/Panel';

/**
 * Every report the person may open, found by the question it answers. The page shell and the search draw at once; the list
 * streams in behind them. Reports are grouped by what they tell you, can be searched with Ctrl or Command and K, and can
 * be starred to keep the ones used most at the top.
 */
export function ReportsHub({ listPromise }: { listPromise: Promise<ListReportsResult> }) {
  return (
    <div className="mx-auto max-w-7xl space-y-5 p-3 sm:p-5">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-fg-strong sm:text-2xl">Reports</h2>
      </header>
      <Suspense fallback={<PanelSkeleton label="the reports" rows={4} />}>
        <Loaded listPromise={listPromise} />
      </Suspense>
    </div>
  );
}

function Loaded({ listPromise }: { listPromise: Promise<ListReportsResult> }) {
  const result = use(listPromise);
  if (!result.ok) return <FailedPanel name="The list of reports" />;
  return <Groups items={result.data} />;
}

function Groups({ items }: { items: readonly ReportListItem[] }) {
  const [query, setQuery] = useState('');
  const { favourites, toggle } = useFavourites();
  // A module in the menu opens this page narrowed to that module.
  const moduleFilter = useSearchParams().get('module');
  const scoped = useMemo(
    () => (moduleFilter === null ? items : items.filter((i) => i.family === moduleFilter)),
    [items, moduleFilter],
  );

  const searchable = useMemo(
    () => scoped.map((i) => ({ ...i, familyLabel: i.familyLabel })),
    [scoped],
  );
  const shown = useMemo(() => searchReports(searchable, query), [searchable, query]);
  const starred = shown.filter((i) => favourites.includes(i.code));
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: ReportListItem[] }>();
    for (const item of shown) {
      const group = map.get(item.family) ?? { label: item.familyLabel, items: [] };
      group.items.push(item);
      map.set(item.family, group);
    }
    return [...map.entries()];
  }, [shown]);

  if (items.length === 0) {
    return (
      <EmptyPanel>
        No reports are open to you yet. Ask an administrator which report permissions you need.
      </EmptyPanel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CommandPalette
          items={items.map((i) => ({
            code: i.code,
            title: i.title,
            question: i.question,
            familyLabel: i.familyLabel,
            keywords: i.keywords,
            href: i.href,
          }))}
        />
        <label className="block text-xs font-semibold text-fg-subtle sm:w-72">
          Filter this list
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="sales, stock, who owes us…"
            className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none"
          />
        </label>
      </div>

      {moduleFilter !== null && scoped[0] !== undefined ? (
        <p className="text-sm text-fg-muted">
          {scoped[0].familyLabel} reports.{' '}
          <Link href="/admin/reports" className="font-semibold text-indigo-700 hover:underline">
            All reports
          </Link>
        </p>
      ) : null}

      {shown.length === 0 ? (
        <EmptyPanel>
          {query === '' ? 'No reports here.' : `No report matches “${query}”. Try fewer words.`}
        </EmptyPanel>
      ) : null}

      {starred.length > 0 ? (
        <Section label="Starred" items={starred} favourites={favourites} onToggle={toggle} />
      ) : null}
      {groups.map(([family, group]) => (
        <Section
          key={family}
          label={group.label}
          items={group.items}
          favourites={favourites}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

function Section({
  label,
  items,
  favourites,
  onToggle,
}: {
  label: string;
  items: readonly ReportListItem[];
  favourites: readonly string[];
  onToggle: (code: string) => void;
}) {
  const id = `reports-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-xs font-bold tracking-wider text-fg-subtle uppercase">
        {label}
      </h3>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const starred = favourites.includes(item.code);
          return (
            <li key={item.code} className="relative">
              <Link
                href={item.href}
                data-testid="report-card"
                className="flex h-full min-h-28 flex-col gap-1 rounded-xl border border-line bg-surface p-4 pr-12 transition hover:border-indigo-500 hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 active:scale-[0.99]"
              >
                <span className="text-sm font-bold text-fg-strong">{item.title}</span>
                <span className="text-xs text-fg-muted">{item.question}</span>
              </Link>
              <button
                type="button"
                aria-pressed={starred}
                aria-label={starred ? `Remove ${item.title} from starred` : `Star ${item.title}`}
                onClick={() => {
                  onToggle(item.code);
                }}
                className="absolute top-2 right-2 inline-flex size-10 items-center justify-center rounded-lg text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                <Star
                  className={`size-4 ${starred ? 'fill-amber-500 text-amber-500' : ''}`}
                  aria-hidden
                />
              </button>
              {item.downloadable ? (
                <Link
                  href={`/admin/reports/${item.code}`}
                  aria-label={`Open ${item.title} with downloads`}
                  className="absolute right-2 bottom-2 inline-flex size-10 items-center justify-center rounded-lg text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
                >
                  <Download className="size-4" aria-hidden />
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
