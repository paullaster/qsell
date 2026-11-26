import { createHash } from 'node:crypto';
import { plainText } from '@/lib/reports/messages';
import type { AccessControlService } from '@/server/domains/access-control/engine';
import { businessTimeZone, formatBusinessTime } from '@/server/kernel/numbering/business-date';
import { readChoice } from '../engine/params';
import type { ReportAuditSink, ReportRunner } from '../engine/run';
import { coverageOf } from './coverage';
import { buildCsv } from './csv';
import { exportFileName, slugOf } from './file-name';
import { buildPdf } from './pdf';
import { tableProblems, type ExportBrand, type ExportFacts } from './table';
import { buildXlsx } from './xlsx';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export type ExportErrorCode =
  | 'forbidden'
  | 'unknown_report'
  | 'bad_format'
  | 'not_exportable'
  | 'too_large'
  | 'bad_params'
  | 'timeout'
  | 'failed';

export type ExportResult =
  | {
      ok: true;
      content: Buffer;
      mime: string;
      fileName: string;
      sha256: string;
      rows: number;
    }
  | { ok: false; code: ExportErrorCode; error: string };

/** A file name from words: lower case letters, digits and hyphens only, so it can never carry a path or a header. */
export const slug = (text: string): string => slugOf(text, 'report');

/**
 * Turns a report into a file. It needs `reports:export` *and* the report's own permissions (the runner checks those
 * before reading anything), refuses a format the report does not offer, refuses an answer that was cut (a file must
 * never pass a partial list off as the whole), draws the table the report built, and records the download with the
 * file's fingerprint **before** handing the file over: if the record cannot be written, no file is given.
 */
export class ReportExportService {
  constructor(
    private readonly deps: {
      runner: ReportRunner;
      access: Pick<AccessControlService, 'can'>;
      audit: ReportAuditSink;
      companyName: () => Promise<string>;
      /** The heading the company chose for the reports of this module (the report's family). */
      brand?: (family: string) => Promise<ExportBrand | undefined>;
      clock?: () => Date;
      timeZone?: () => string;
    },
  ) {}

  async export(
    userId: string,
    code: string,
    rawParams: unknown,
    rawFormat: unknown,
  ): Promise<ExportResult> {
    const format = readChoice(rawFormat, EXPORT_FORMATS);
    if (format === undefined) {
      return { ok: false, code: 'bad_format', error: 'Choose CSV, Excel or PDF.' };
    }
    const def = this.deps.runner.definition(code);
    if (def === undefined) {
      return { ok: false, code: 'unknown_report', error: 'That report does not exist.' };
    }
    if (!(await this.deps.access.can(userId, 'reports:export'))) {
      return {
        ok: false,
        code: 'forbidden',
        error: 'You do not have permission to download reports.',
      };
    }
    if (!def.exportFormats.includes(format)) {
      return {
        ok: false,
        code: 'not_exportable',
        error: 'This report cannot be downloaded in that format.',
      };
    }

    const run = await this.deps.runner.run(code, rawParams, userId, { table: true });
    if (!run.ok) {
      return { ok: false, code: run.code, error: run.error };
    }
    const table = run.table;
    if (table === undefined) {
      return { ok: false, code: 'not_exportable', error: 'This report cannot be downloaded yet.' };
    }
    if (run.meta.truncated || table.rows.length > def.maxRows) {
      return {
        ok: false,
        code: 'too_large',
        error:
          'This report has more rows than one download can hold. Narrow the period or the branch and try again.',
      };
    }
    const problems = tableProblems(table);
    if (problems.length > 0) {
      console.error(`[reports.export] ${code} built an unsafe table`, problems);
      return {
        ok: false,
        code: 'failed',
        error: 'This report could not be prepared for download.',
      };
    }

    const now = (this.deps.clock ?? (() => new Date()))();
    const timeZone = (this.deps.timeZone ?? businessTimeZone)();
    const companyName = await this.deps.companyName();
    const coverage = coverageOf(run.data, run.meta.asOf, timeZone);
    const brand = await this.deps.brand?.(def.family);
    const facts: ExportFacts = {
      companyName,
      reportTitle: plainText(def.titleId),
      question: plainText(def.questionId),
      asOf: run.meta.asOf,
      scope: coverage.scope,
      definitionsVersion: run.meta.definitionsVersion,
      period: coverage.period,
      printedAt: formatBusinessTime(now, timeZone),
      ...(brand === undefined ? {} : { brand }),
    };

    let content: Buffer;
    try {
      content = await draw(format, table, facts);
    } catch (error) {
      console.error(`[reports.export] ${code} could not be drawn as ${format}`, error);
      return {
        ok: false,
        code: 'failed',
        error: 'This report could not be prepared for download.',
      };
    }
    const sha256 = createHash('sha256').update(content).digest('hex');

    try {
      await this.deps.audit.record({
        userId,
        reportCode: def.code,
        action: 'export',
        params: run.params,
        definitionsVersion: run.meta.definitionsVersion,
        rowCount: table.rows.length,
        truncated: false,
        format,
        contentHash: sha256,
      });
    } catch (error) {
      console.error(`[reports.export] the download of ${code} could not be recorded`, error);
      return {
        ok: false,
        code: 'failed',
        error: 'The download could not be recorded, so it was not given. Please try again.',
      };
    }

    return {
      ok: true,
      content,
      mime: MIME[format],
      fileName: exportFileName({
        business: companyName,
        report: facts.reportTitle,
        now,
        timeZone,
        extension: format,
      }),
      sha256,
      rows: table.rows.length,
    };
  }
}

async function draw(
  format: ExportFormat,
  table: Parameters<typeof buildCsv>[0],
  facts: ExportFacts,
): Promise<Buffer> {
  switch (format) {
    case 'csv':
      return Buffer.from(buildCsv(table, facts), 'utf8');
    case 'xlsx':
      return buildXlsx(table, facts);
    case 'pdf':
      return await buildPdf(table, facts);
  }
}
