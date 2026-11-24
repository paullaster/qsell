'use client';

import { BackButton } from '../kit/BackButton';
import { DEMO_METHODS, DEMO_PRODUCTS, demoBranchMonths, demoDays } from '@/lib/reports/demo-data';
import { formatLocalDate } from '@/lib/reports/format';
import { PALETTE } from '@/lib/reports/chart/palette';
import { Bars } from '../charts/Bars';
import { Bullet } from '../charts/Bullet';
import { Donut } from '../charts/Donut';
import { LineArea } from '../charts/LineArea';
import { RankedBars } from '../charts/RankedBars';
import { Sparkline } from '../charts/Sparkline';
import { DataTable } from '../kit/DataTable';
import { Delta, HeroStrip, Kpi } from '../kit/Hero';
import { EmptyPanel, FailedPanel, Panel, PanelSkeleton } from '../kit/Panel';

const KES = { kind: 'money', currency: 'KES' } as const;

/**
 * Every part of the report kit with a believable year of data, in one place: the page designers and reviewers use to judge a
 * change, and the one the screenshot tests photograph. Nothing here reads the database; the data is fixed.
 */
export function StyleGuide() {
  const days = demoDays('2026-02-10', 30);
  const previous = demoDays('2025-02-10', 30, 3);
  const { months, byBranch } = demoBranchMonths();
  const sales = days.map((d) => d.sales);
  const total = sales.reduce((a, b) => a + b, 0);
  const previousTotal = previous.reduce((a, d) => a + d.sales, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-3 sm:p-5" data-testid="style-guide">
      <BackButton />
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-fg-strong sm:text-2xl">Report style guide</h2>
        <p className="max-w-3xl text-sm text-fg-muted">
          The parts every report is built from, drawn with a fixed year of demonstration data.
          Change this page when the kit changes, and check it at phone width, in dark mode and on
          paper.
        </p>
      </header>

      <HeroStrip label="Headline figures">
        <Kpi
          label="Sales"
          value="KES 3.4M"
          fullValue={`KES ${total.toLocaleString('en-KE')}`}
          hero
          trend={sales}
        >
          <Delta current={total} previous={previousTotal} basis="same days last year" />
        </Kpi>
        <Kpi
          label="Orders"
          value={days.reduce((a, d) => a + d.orders, 0).toLocaleString('en-KE')}
          trend={days.map((d) => d.orders)}
        >
          <Delta current={1840} previous={1990} basis="last month" />
        </Kpi>
        <Kpi label="Overdue to us" value="KES 412,300" note="From 38 customers">
          <Delta current={412300} previous={350100} basis="last month" upIsGood={false} />
        </Kpi>
        <Kpi label="Margin" value="27.4%" note="On 92% of sales with a known cost">
          <Delta current={27.4} previous={27.4} basis="last month" />
        </Kpi>
      </HeroStrip>

      <Panel
        id="sg-line"
        title="Sales per day"
        definition="Every order that counts as a sale, by the day it was placed, against the same days a year earlier."
      >
        <LineArea
          categories={days.map((d) => formatLocalDate(d.date).replace(/ \d{4}$/, ''))}
          series={[
            { key: 'now', label: 'This period', values: sales },
            {
              key: 'then',
              label: 'Same days last year',
              values: previous.map((d) => d.sales),
              dashed: true,
            },
          ]}
          unit={KES}
          ariaLabel="Sales per day"
        />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          id="sg-bars"
          title="Sales by branch, by month"
          definition="Grouped bars start at zero, so their heights can be compared."
        >
          <Bars
            categories={months.slice(0, 6)}
            series={byBranch.map((b) => ({
              key: b.label,
              label: b.label,
              values: b.values.slice(0, 6),
            }))}
            unit={KES}
            ariaLabel="Sales by branch and month"
            categoryLabel="Month"
          />
        </Panel>
        <Panel
          id="sg-stack"
          title="Sales by branch, stacked"
          definition="The same figures piled up, to see the whole as well as the parts."
        >
          <Bars
            stacked
            categories={months.slice(0, 6)}
            series={byBranch.map((b) => ({
              key: b.label,
              label: b.label,
              values: b.values.slice(0, 6),
            }))}
            unit={KES}
            ariaLabel="Stacked sales by branch"
            categoryLabel="Month"
          />
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          id="sg-ranked"
          title="Best selling products"
          definition="Ranked by sales value, with the change against the comparison period."
        >
          <RankedBars items={DEMO_PRODUCTS} unit={KES} ariaLabel="Best selling products" />
        </Panel>
        <Panel
          id="sg-donut"
          title="How customers paid"
          definition="A share of the whole, for a handful of parts. More than six parts are folded into Other."
        >
          <Donut
            items={DEMO_METHODS}
            unit={KES}
            centerLabel="collected"
            ariaLabel="Money collected by method"
          />
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          id="sg-targets"
          title="Against target"
          definition="Actual against target on one bar. The state is also written in words."
        >
          <div className="space-y-4">
            <Bullet label="Nairobi CBD" actual={1_820_000} target={1_900_000} unit={KES} />
            <Bullet label="Westlands" actual={1_210_000} target={1_400_000} unit={KES} />
            <Bullet label="Mombasa" actual={640_000} target={1_100_000} unit={KES} />
            <Bullet label="Kisumu" actual={310_000} target={null} unit={KES} />
          </div>
        </Panel>
        <Panel
          id="sg-states"
          title="Loading, empty and failed"
          definition="Every panel says what is happening and what to do next."
        >
          <div className="space-y-3">
            <PanelSkeleton label="a demonstration panel" rows={1} />
            <EmptyPanel>
              No sales in this branch for these days. The last sale was on 14 Nov.
            </EmptyPanel>
            <FailedPanel name="The demonstration panel" onRetry={() => undefined} />
            <Sparkline values={sales} label="Sales trend" />
          </div>
        </Panel>
      </div>

      <Panel
        id="sg-table"
        title="Table"
        definition="Sort by a header, keep the first column in view, and on a phone each row becomes a card."
      >
        <DataTable
          caption="Branch sales by month"
          columns={[
            { label: 'Branch', kind: 'text' },
            ...months.slice(0, 4).map((m) => ({ label: m, kind: 'money' as const })),
            { label: 'Share', kind: 'percent' },
          ]}
          rows={byBranch.map((b, i) => ({
            id: b.label,
            cells: [b.label, ...b.values.slice(0, 4), [38, 28, 22, 12][i] ?? 0],
            href: '#',
          }))}
          totals={[
            'Total',
            ...months
              .slice(0, 4)
              .map((_, m) => byBranch.reduce((a, b) => a + (b.values[m] ?? 0), 0)),
            100,
          ]}
          emptyMessage="Nothing to show."
        />
      </Panel>

      <Panel
        id="sg-colours"
        title="Data colours"
        definition="Eight colours that stay apart for people with colour-vision deficiency, in light and dark."
      >
        <div className="space-y-3">
          {(['light', 'dark'] as const).map((theme) => (
            <div key={theme}>
              <p className="mb-1 text-xs font-semibold text-fg-subtle capitalize">
                {theme} theme values
              </p>
              <ul className="flex flex-wrap gap-2">
                {PALETTE[theme].categorical.map((hex, i) => (
                  <li key={hex} className="flex items-center gap-1.5 text-xs text-fg-muted">
                    <span
                      aria-hidden
                      className="inline-block size-5 rounded"
                      style={{ background: hex }}
                    />
                    {i + 1}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <ul className="flex flex-wrap gap-2" aria-label="Colours in use now">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <li key={n} className="flex items-center gap-1.5 text-xs text-fg-muted">
                <span
                  aria-hidden
                  className="inline-block size-5 rounded"
                  style={{ background: `var(--data-${String(n)})` }}
                />
                {n}
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </div>
  );
}
