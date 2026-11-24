import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requireStaff } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { plainText } from '@/lib/reports/messages';
import { formatInstant } from '@/lib/reports/format';
import { businessTimeZone } from '@/server/kernel/numbering/business-date';
import { DataTable } from '@/components/reports/kit/DataTable';
import { EmptyPanel, FailedPanel, Panel, PanelSkeleton } from '@/components/reports/kit/Panel';
import { ReportFrame } from '@/components/reports/kit/ReportFrame';
import { ExportButtons } from '@/components/reports/kit/ExportButtons';
import { AnalysisView } from '@/components/reports/kit/AnalysisView';
import { StatementView } from '@/components/reports/kit/StatementView';
import { FilterBar } from '@/components/reports/kit/FilterBar';
import { filterStateOf } from '@/components/reports/kit/report-filters';
import type {
  AnalysisReport,
  ReportBody,
  ReportFacts,
  StatementReport,
} from '@/server/domains/reports/analysis/types';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: 'Report' };

/** The period bar for a report that has a period; a report about stock or balances as they are now has none to offer. */
function Filters({
  facts,
  asOf,
  children,
}: {
  facts: ReportFacts;
  asOf: string;
  children: React.ReactNode;
}) {
  if (facts.asAtNow === true) return <div className="space-y-5">{children}</div>;
  return <FilterBar filters={filterStateOf(facts, asOf)}>{children}</FilterBar>;
}

const isAnalysis = (data: unknown): data is AnalysisReport =>
  typeof data === 'object' && data !== null && (data as ReportBody).kind === 'analysis';

const isStatement = (data: unknown): data is StatementReport =>
  typeof data === 'object' && data !== null && (data as ReportBody).kind === 'statement';

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * A report drawn by the registry: the frame, the facts it states about itself and its table, with download buttons when it
 * offers them. Whether the person may open it is decided before anything is drawn (a report they may not open is a 404, as
 * a report that does not exist); the figures then stream in behind the frame.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  const { code } = await params;
  const raw = await searchParams;
  const userId = await requireStaff();
  const runner = getContainer().reportRunner;
  const def = runner.definition(code);
  const open = def !== undefined && (await runner.list(userId)).some((r) => r.code === code);
  if (def === undefined || !open) notFound();
  // A report with a screen of its own that is not drawn here keeps that screen.
  if (def.href !== undefined && def.exportFormats.length === 0) redirect(def.href);

  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const v = first(value);
    if (v !== undefined) input[key] = v;
  }

  return (
    <Suspense fallback={<PanelSkeleton label={plainText(def.titleId)} rows={4} />}>
      <Body code={code} input={input} userId={userId} />
    </Suspense>
  );
}

async function Body({
  code,
  input,
  userId,
}: {
  code: string;
  input: Record<string, string>;
  userId: string;
}) {
  const runner = getContainer().reportRunner;
  const def = runner.definition(code);
  if (def === undefined) notFound();
  const run = await runner.run(code, input, userId, { table: true });
  const title = plainText(def.titleId);
  if (!run.ok) {
    return (
      <ReportFrame title={title}>
        <FailedPanel name={title} />
      </ReportFrame>
    );
  }
  const table = run.table;
  const structured = isStatement(run.data) || isAnalysis(run.data) ? run.data : null;
  const asOf = formatInstant(run.meta.asOf, businessTimeZone());
  const query = new URLSearchParams(input).toString();
  return (
    <ReportFrame
      title={title}
      {...(structured?.facts.asAtNow === true ? { note: `As at ${asOf}` } : {})}
      actions={
        def.exportFormats.length > 0 && table !== undefined ? (
          <ExportButtons
            code={code}
            formats={def.exportFormats}
            query={query}
            truncated={run.meta.truncated}
          />
        ) : undefined
      }
    >
      {structured !== null ? (
        <Filters facts={structured.facts} asOf={asOf}>
          {structured.kind === 'statement' ? (
            <StatementView report={structured} />
          ) : (
            <AnalysisView report={structured} />
          )}
        </Filters>
      ) : (
        <Panel id="report-table" title={table?.title ?? title}>
          {table === undefined ? (
            <EmptyPanel>This report has no table to show here.</EmptyPanel>
          ) : (
            <>
              {run.meta.truncated ? (
                <p
                  role="status"
                  className="rounded-lg border border-amber-700 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                >
                  Only the first rows are shown. Narrow the report to see the rest.
                </p>
              ) : null}
              <DataTable
                caption={table.title}
                columns={table.columns}
                rows={table.rows.map((cells, i) => {
                  const href = table.rowLinks?.[i];
                  return {
                    id: `row-${String(i)}`,
                    cells,
                    ...(href === null || href === undefined ? {} : { href }),
                  };
                })}
                {...(table.totals === undefined ? {} : { totals: table.totals })}
                emptyMessage="Nothing to show for these choices."
              />
            </>
          )}
        </Panel>
      )}
    </ReportFrame>
  );
}
