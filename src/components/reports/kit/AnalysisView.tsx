import { formatMoney } from '@/lib/reports/format';
import { formatters } from '@/lib/reports/units';
import type {
  AnalysisReport,
  ChartSpec,
  Kpi as KpiData,
} from '@/server/domains/reports/analysis/types';
import { Bars } from '../charts/Bars';
import { Donut } from '../charts/Donut';
import { LineArea } from '../charts/LineArea';
import { RankedBars } from '../charts/RankedBars';
import { DataTable } from './DataTable';
import { Delta, HeroStrip, Kpi } from './Hero';
import { EmptyPanel, Panel } from './Panel';
import { comparisonWords } from './report-filters';

/** The heading over the table: what each row is ("By product"), never the report's own title again. */
export function tableHeading(firstColumn: string | undefined): string {
  if (firstColumn === undefined) return 'Details';
  if (firstColumn === 'Who') return 'Customers';
  return `By ${firstColumn.toLowerCase()}`;
}

export function KpiCard({ kpi, basis }: { kpi: KpiData; basis: string }) {
  const fmt = formatters(kpi.unit);
  const value = kpi.value === null ? '–' : fmt.value(kpi.value);
  return (
    <Kpi label={kpi.label} value={value} {...(kpi.note === undefined ? {} : { note: kpi.note })}>
      {kpi.previous !== undefined &&
      kpi.previous !== null &&
      kpi.value !== null &&
      kpi.unit.kind !== 'percent' ? (
        <Delta
          current={kpi.value}
          previous={kpi.previous}
          basis={basis}
          upIsGood={kpi.upIsGood ?? true}
        />
      ) : null}
      {kpi.previous !== undefined &&
      kpi.previous !== null &&
      kpi.value !== null &&
      kpi.unit.kind === 'percent' ? (
        <p className="text-xs text-fg-subtle">
          Was {fmt.value(kpi.previous)} in {basis}
        </p>
      ) : null}
    </Kpi>
  );
}

function Chart({ chart }: { chart: ChartSpec }) {
  switch (chart.kind) {
    case 'line':
      return (
        <LineArea
          categories={chart.categories}
          series={chart.series}
          unit={chart.unit}
          ariaLabel={chart.title}
        />
      );
    case 'bars':
      return (
        <Bars
          categories={chart.categories}
          series={chart.series}
          unit={chart.unit}
          ariaLabel={chart.title}
          {...(chart.stacked === true ? { stacked: true } : {})}
        />
      );
    case 'ranked':
      return <RankedBars items={chart.items} unit={chart.unit} ariaLabel={chart.title} />;
    case 'donut':
      return (
        <Donut
          items={chart.items}
          unit={chart.unit}
          centerLabel={chart.centerLabel}
          ariaLabel={chart.title}
        />
      );
  }
}

/**
 * An analysis report: headline figures with their change on the comparison, one or two charts, the table with a link on every
 * row that has somewhere to go, the proof that it adds up to the Business Overview, and the sentences saying what is counted.
 * Everything is drawn from the report's own data; nothing here works a figure out.
 */
export function AnalysisView({ report }: { report: AnalysisReport }) {
  const { facts, table } = report;
  const basis = comparisonWords(facts);
  const hasRows = table.rows.length > 0;
  return (
    <div className="space-y-5">
      {facts.notice === null ? null : (
        <p
          role="status"
          className="rounded-lg border border-amber-700 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {facts.notice}
        </p>
      )}
      <HeroStrip label="Headline figures">
        {report.kpis.map((kpi) => (
          <KpiCard key={kpi.key} kpi={kpi} basis={basis} />
        ))}
      </HeroStrip>

      {hasRows ? (
        <>
          {report.charts.length > 0 ? (
            <div className={report.charts.length > 1 ? 'grid gap-5 lg:grid-cols-2' : ''}>
              {report.charts.map((chart) => (
                <Panel
                  key={chart.title}
                  id={`chart-${chart.kind}-${chart.title.replace(/\W+/g, '-').toLowerCase()}`}
                  title={chart.title}
                >
                  <Chart chart={chart} />
                </Panel>
              ))}
            </div>
          ) : null}
          <Panel id="report-table" title={tableHeading(table.columns[0]?.label)}>
            <DataTable
              caption={table.title}
              columns={table.columns}
              rows={table.rows.map((cells, i) => {
                const href = report.rowLinks[i];
                return {
                  id: `row-${String(i)}`,
                  cells,
                  ...(href === null || href === undefined ? {} : { href }),
                };
              })}
              {...(table.totals === undefined ? {} : { totals: table.totals })}
              emptyMessage="Nothing to show for these choices."
            />
          </Panel>
        </>
      ) : (
        <EmptyPanel>
          {facts.asAtNow === true
            ? 'Nothing to list.'
            : 'Nothing recorded for these dates. Try a longer period or another branch.'}
        </EmptyPanel>
      )}

      {report.reconciliation.length > 0 ? (
        <Panel id="reconciliation" title="How this adds up to the Business Overview">
          <dl className="divide-y divide-line text-sm">
            {report.reconciliation.map((line) => (
              <div
                key={line.label}
                className={`flex items-baseline justify-between gap-3 py-2 ${line.strong === true ? 'font-bold text-fg-strong' : 'text-fg'}`}
              >
                <dt>{line.label}</dt>
                <dd className="tabular-nums">{formatMoney(line.value, facts.baseCurrency)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      ) : null}

      {report.notes.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-fg-muted">
          <summary className="min-h-8 cursor-pointer py-1 font-semibold text-fg">
            How this is counted
          </summary>
          <div className="mt-2 space-y-1.5">
            {report.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
