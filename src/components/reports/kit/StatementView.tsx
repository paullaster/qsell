import { CheckCircle2, XCircle } from 'lucide-react';
import { formatPercent } from '@/lib/reports/format';
import type { StatementLine, StatementReport } from '@/server/domains/reports/analysis/types';
import { KpiCard } from './AnalysisView';
import { HeroStrip } from './Hero';
import { Panel } from './Panel';
import { comparisonWords } from './report-filters';

type Column = StatementReport['columns'][number];

/** A statement writes a negative amount in brackets and leaves a cell with nothing empty. */
export function statementCell(value: number | null, kind: Column['kind']): string {
  if (value === null) return '';
  if (kind === 'percent') return formatPercent(value, 1);
  const text = Math.abs(value).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `(${text})` : text;
}

const LABEL_STYLE: Record<StatementLine['kind'], string> = {
  heading: 'font-bold text-fg-strong',
  line: 'font-normal text-fg',
  subtotal: 'font-semibold text-fg-strong',
  total: 'font-bold text-fg-strong',
};

const ROW_STYLE: Record<StatementLine['kind'], string> = {
  heading: 'bg-surface-sunken',
  line: '',
  subtotal: 'border-t border-line',
  total: 'border-t-2 border-line-strong bg-surface-sunken',
};

const INDENT = ['pl-3', 'pl-6', 'pl-9'] as const;

function Checks({ report }: { report: StatementReport }) {
  if (report.checks.length === 0) return null;
  return (
    <section aria-label="Checks on this statement" className="space-y-2">
      {report.checks.map((c) =>
        c.ok ? (
          <p key={c.key} className="flex items-center gap-1.5 text-xs text-fg-muted">
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-700" aria-hidden />
            {c.label}
          </p>
        ) : (
          <p
            key={c.key}
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-900"
          >
            <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="font-semibold">Does not agree: </span>
              {c.label}. {c.detail}. Do not rely on this statement until the difference is
              explained.
            </span>
          </p>
        ),
      )}
    </section>
  );
}

/**
 * A financial statement: headline figures, the proofs that it agrees with the books, and the statement itself. On a phone each
 * line is a small card (the label, this period's figure, and the others beneath), because a four-column statement does not fit
 * a narrow screen. From tablet width it is a table that keeps its headings in view.
 */
export function StatementView({ report }: { report: StatementReport }) {
  const { facts, columns, lines } = report;
  const basis = comparisonWords(facts);
  const first = columns[0];
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
      {report.kpis.length > 0 ? (
        <HeroStrip label="Headline figures">
          {report.kpis.map((kpi) => (
            <KpiCard key={kpi.key} kpi={kpi} basis={basis} />
          ))}
        </HeroStrip>
      ) : null}
      <Checks report={report} />

      <Panel id="statement" title="Statement">
        {/* From tablet width: a table. */}
        <div className="hidden md:block">
          <table className="w-full table-fixed text-sm" data-testid="statement-table">
            <caption className="sr-only">{report.table.title}</caption>
            <thead>
              <tr className="border-b border-line-strong text-xs text-fg-subtle">
                <th scope="col" className="w-2/5 px-3 py-2 text-left font-semibold">
                  <span className="sr-only">Line</span>
                </th>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="px-3 py-2 text-right font-semibold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} className={ROW_STYLE[l.kind]}>
                  <th
                    scope="row"
                    className={`px-3 py-1.5 text-left break-words ${INDENT[l.indent]} ${LABEL_STYLE[l.kind]}`}
                  >
                    {l.label}
                  </th>
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      className={`px-3 py-1.5 text-right tabular-nums ${LABEL_STYLE[l.kind]}`}
                    >
                      {statementCell(l.values[i] ?? null, c.kind)}
                      {i === 0 && l.shares?.[0] !== undefined && l.shares[0] !== null ? (
                        <span className="ml-2 text-xs font-normal text-fg-subtle">
                          {formatPercent(l.shares[0], 1)}
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* On a phone: a card per line. */}
        <ul className="divide-y divide-line md:hidden" aria-label={report.table.title}>
          {lines.map((l) =>
            l.kind === 'heading' ? (
              <li
                key={l.key}
                className={`bg-surface-sunken px-3 py-2 text-sm ${LABEL_STYLE.heading} ${INDENT[l.indent]}`}
              >
                {l.label}
              </li>
            ) : (
              <li key={l.key} className={`px-3 py-2 ${ROW_STYLE[l.kind]}`}>
                <div
                  className={`flex items-baseline justify-between gap-3 text-sm ${INDENT[l.indent]} ${LABEL_STYLE[l.kind]}`}
                >
                  <span className="min-w-0 break-words">{l.label}</span>
                  <span className="tabular-nums">
                    {first === undefined ? '' : statementCell(l.values[0] ?? null, first.kind)}
                  </span>
                </div>
                {columns.length > 1 ? (
                  <dl
                    className={`mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-fg-muted ${INDENT[l.indent]}`}
                  >
                    {columns.slice(1).map((c, i) => {
                      const v = l.values[i + 1] ?? null;
                      return v === null ? null : (
                        <div key={c.key} className="flex gap-1">
                          <dt>{c.label}:</dt>
                          <dd className="tabular-nums">{statementCell(v, c.kind)}</dd>
                        </div>
                      );
                    })}
                  </dl>
                ) : null}
              </li>
            ),
          )}
        </ul>
      </Panel>

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
