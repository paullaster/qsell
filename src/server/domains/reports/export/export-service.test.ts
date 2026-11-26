import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readXlsxRows } from '@/server/domains/finance/domain/xlsx-lite';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { ReportDefinition } from '../registry/definition';
import {
  ReportRunner,
  registerExecutor,
  type ReportAuditEntry,
  type ReportExecutor,
} from '../engine/run';
import { ReportExportService, slug } from './export-service';
import type { ExportTable } from './table';

const NOW = new Date('2026-03-10T18:00:00Z');

const TABLE: ExportTable = {
  title: 'Stub',
  columns: [
    { label: 'Name', kind: 'text' },
    { label: 'Amount', kind: 'money' },
  ],
  rows: [
    ['Wanjiku', 1200.5],
    ['=EVIL()', 99],
  ],
  totals: ['Total', 1299.5],
};

const def = (over: Partial<ReportDefinition> = {}): ReportDefinition => ({
  code: 'stub-report',
  titleId: 'report.receivables_ageing.title',
  questionId: 'report.receivables_ageing.question',
  family: 'finance',
  permissions: ['receivables_ageing:read'],
  measures: ['receivables.outstanding'],
  dimensions: ['customer'],
  tier: 'live',
  scope: 'company',
  tieOut: { kind: 'none', reason: 'A stub report that ties to nothing at all.' },
  sensitivity: 'normal',
  exportFormats: ['csv', 'xlsx', 'pdf'],
  maxRows: 100,
  timeoutMs: 5_000,
  keywords: ['stub', 'sample'],
  docs: { file: '01-business-overview-and-dashboard.md', heading: 'Section C' },
  view: 'legacy',
  href: '/admin/reports/receivables-ageing',
  catalogue: 'complete',
  ...over,
});

interface Setup {
  held?: PermissionKey[];
  report?: Partial<ReportDefinition>;
  execution?: { table?: ExportTable; truncated?: boolean };
  /** The report builds no table (it cannot be downloaded). */
  noTable?: boolean;
  audit?: (e: ReportAuditEntry) => Promise<void>;
}

function setup(s: Setup = {}) {
  const held: PermissionKey[] = s.held ?? ['receivables_ageing:read', 'reports:export'];
  const access = { can: (_u: string, k: PermissionKey) => Promise.resolve(held.includes(k)) };
  const executor: ReportExecutor<Record<string, never>, { ok: true }> = {
    code: 'stub-report',
    permissions: [],
    readParams: () => ({ ok: true, params: {} }),
    execute: ({ wantTable }) =>
      Promise.resolve({
        data: { ok: true as const },
        truncated: s.execution?.truncated ?? false,
        ...(wantTable && s.noTable !== true ? { table: s.execution?.table ?? TABLE } : {}),
      }),
  };
  const runner = new ReportRunner({
    access,
    executors: [registerExecutor(executor)],
    reports: [def(s.report)],
    clock: () => NOW,
  });
  const entries: ReportAuditEntry[] = [];
  const service = new ReportExportService({
    runner,
    access,
    audit: {
      record:
        s.audit ??
        ((e) => {
          entries.push(e);
          return Promise.resolve();
        }),
    },
    companyName: () => Promise.resolve('Acme Traders Ltd'),
    clock: () => NOW,
    timeZone: () => 'Africa/Nairobi',
  });
  return { service, entries };
}

describe('export service', () => {
  it('writes each format, fingerprints it and records the download first', async () => {
    for (const format of ['csv', 'xlsx', 'pdf'] as const) {
      const { service, entries } = setup();
      const r = await service.export('u1', 'stub-report', {}, format);
      expect(r.ok, format).toBe(true);
      if (!r.ok) continue;
      expect(r.sha256).toBe(createHash('sha256').update(r.content).digest('hex'));
      expect(r.fileName).toBe(`acme-traders-ltd_receivables-ageing_20260310-210000.${format}`);
      expect(r.rows).toBe(2);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        userId: 'u1',
        reportCode: 'stub-report',
        action: 'export',
        format,
        rowCount: 2,
        contentHash: r.sha256,
        truncated: false,
      });
    }
  });

  it('gives the right content type', async () => {
    const { service } = setup();
    const mimes = await Promise.all(
      (['csv', 'xlsx', 'pdf'] as const).map(async (f) => {
        const r = await service.export('u1', 'stub-report', {}, f);
        return r.ok ? r.mime : 'failed';
      }),
    );
    expect(mimes).toEqual([
      'text/csv; charset=utf-8',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/pdf',
    ]);
  });

  it('writes the same figures in every format and neutralises formulas', async () => {
    const { service } = setup();
    const csv = await service.export('u1', 'stub-report', {}, 'csv');
    const xlsx = await service.export('u1', 'stub-report', {}, 'xlsx');
    if (!csv.ok || !xlsx.ok) throw new Error('expected files');
    const text = csv.content.toString('utf8');
    expect(text).toContain("'=EVIL()");
    expect(text).toContain('1200.50');
    const rows = readXlsxRows(xlsx.content);
    expect(rows[2]?.[0]).toBe("'=EVIL()");
    expect(rows[1]?.[1]).toBe('1200.5');
    expect(csv.content.subarray(0, 3).toString('hex')).toBe('efbbbf');
  });

  it('refuses a format it does not know', async () => {
    const { service, entries } = setup();
    for (const bad of ['docx', '', undefined, 5, ['csv']]) {
      expect(await service.export('u1', 'stub-report', {}, bad)).toMatchObject({
        ok: false,
        code: 'bad_format',
      });
    }
    expect(entries).toEqual([]);
  });

  it('refuses an unknown report and a format the report does not offer', async () => {
    const { service } = setup({ report: { exportFormats: ['csv'] } });
    expect(await service.export('u1', 'nothing', {}, 'csv')).toMatchObject({
      code: 'unknown_report',
    });
    expect(await service.export('u1', 'stub-report', {}, 'pdf')).toMatchObject({
      code: 'not_exportable',
    });
  });

  it('needs the export permission and the report permission, and records nothing when refused', async () => {
    const noExport = setup({ held: ['receivables_ageing:read'] });
    expect(await noExport.service.export('u1', 'stub-report', {}, 'csv')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    const noReport = setup({ held: ['reports:export'] });
    expect(await noReport.service.export('u1', 'stub-report', {}, 'csv')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(noExport.entries).toEqual([]);
    expect(noReport.entries).toEqual([]);
  });

  it('refuses a cut list rather than passing it off as the whole', async () => {
    const { service, entries } = setup({ execution: { truncated: true } });
    expect(await service.export('u1', 'stub-report', {}, 'csv')).toMatchObject({
      ok: false,
      code: 'too_large',
    });
    expect(entries).toEqual([]);
  });

  it('refuses a table over the report row limit even when it was not flagged', async () => {
    const big: ExportTable = { ...TABLE, rows: Array.from({ length: 101 }, () => ['x', 1]) };
    const { service } = setup({ execution: { table: big } });
    expect(await service.export('u1', 'stub-report', {}, 'csv')).toMatchObject({
      code: 'too_large',
    });
  });

  it('says so when a report has no table to download', async () => {
    const { service } = setup({ noTable: true });
    const r = await service.export('u1', 'stub-report', {}, 'csv');
    expect(r).toMatchObject({ ok: false, code: 'not_exportable' });
  });

  it('refuses a table that is not safe to write', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad: ExportTable = { ...TABLE, rows: [['only one cell']] };
    const { service } = setup({ execution: { table: bad } });
    expect(await service.export('u1', 'stub-report', {}, 'csv')).toMatchObject({
      ok: false,
      code: 'failed',
    });
    spy.mockRestore();
  });

  it('gives no file when the download cannot be recorded', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { service } = setup({ audit: () => Promise.reject(new Error('audit table missing')) });
    const r = await service.export('u1', 'stub-report', {}, 'csv');
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(r)).not.toMatch(/audit table missing/);
    spy.mockRestore();
  });
});

describe('file names', () => {
  it('are made of letters, digits and hyphens only', () => {
    expect(slug('What we owe (payables ageing)')).toBe('what-we-owe-payables-ageing');
    expect(slug('../../etc/passwd')).toBe('etc-passwd');
    expect(slug('Ñandi "quote"\r\nHeader: x')).toBe('nandi-quote-header-x');
    expect(slug('')).toBe('report');
    expect(slug('!!!')).toBe('report');
    expect(slug('a'.repeat(200)).length).toBe(60);
  });
});
