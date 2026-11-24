'use server';

import { plainText } from '@/lib/reports/messages';
import { requirePermission, requireStaff } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { readOverviewParams } from './engine/params';
import type { RunResult } from './engine/run';
import { FAMILY_LABELS, REPORTS, type FamilyCode } from './registry';
import type { OverviewRequest } from './service';
import type { BusinessOverview } from './types';

/**
 * Business Overview data. Opening the page needs `dashboard:read`; each section is then
 * computed only if the caller holds that section's own permission (see ReportsService).
 */
export async function getBusinessOverviewAction(
  input: OverviewRequest = {},
): Promise<BusinessOverview> {
  const userId = await requirePermission('dashboard:read');
  return await getContainer().reports.getBusinessOverview(userId, readOverviewParams(input));
}

/**
 * Run any registered report. The registry decides which permissions the report needs and the runner checks them
 * before anything is read; parameters are read by the report's own reader, never trusted. The answer comes back as
 * data (`ok` or not), because server-action errors are masked in production.
 */
export async function runReportAction(code: unknown, params: unknown): Promise<RunResult<unknown>> {
  let userId: string;
  try {
    userId = await requireStaff();
  } catch {
    return { ok: false, code: 'forbidden', error: 'Please sign in again to see reports.' };
  }
  if (typeof code !== 'string' || code.length === 0 || code.length > 80) {
    return { ok: false, code: 'unknown_report', error: 'That report does not exist.' };
  }
  return await getContainer().reportRunner.run(code, params, userId);
}

/** One row of the Report activity list. */
export interface AuditListItem {
  id: number;
  userId: string;
  /** The person's name, or null if they are no longer in the system. */
  userName: string | null;
  /** The report's title in words, or the code itself for a report that no longer exists. */
  reportTitle: string;
  reportCode: string;
  action: 'run' | 'export';
  format: string | null;
  rowCount: number | null;
  truncated: boolean;
  contentHash: string | null;
  definitionsVersion: string;
  occurredAt: string;
}

export type AuditListResult =
  { ok: true; data: { rows: AuditListItem[]; next: number | null } } | { ok: false; error: string };

/**
 * Who ran or downloaded sensitive reports, newest first, a page at a time. Needs `reports:view_audit`. The filters are
 * read here: a code must look like a report code and an action must be one of the two, anything else is dropped.
 */
export async function listReportAuditAction(input: {
  reportCode?: unknown;
  action?: unknown;
  before?: unknown;
}): Promise<AuditListResult> {
  try {
    await requirePermission('reports:view_audit');
  } catch {
    return { ok: false, error: 'You do not have permission to see report activity.' };
  }
  const code =
    typeof input.reportCode === 'string' && /^[a-z0-9-]{1,80}$/.test(input.reportCode)
      ? input.reportCode
      : undefined;
  const action = input.action === 'run' || input.action === 'export' ? input.action : undefined;
  const before =
    typeof input.before === 'number' && Number.isInteger(input.before) && input.before > 0
      ? input.before
      : undefined;
  const page = await getContainer().reportAudit.list(
    {
      ...(code === undefined ? {} : { reportCode: code }),
      ...(action === undefined ? {} : { action }),
    },
    before === undefined ? {} : { before },
  );
  const names = await getContainer().reportAudit.namesOf(page.rows.map((r) => r.userId));
  const titles = new Map(REPORTS.map((d) => [d.code, plainText(d.titleId)]));
  return {
    ok: true,
    data: {
      rows: page.rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userName: names.get(r.userId) ?? null,
        reportTitle: titles.get(r.reportCode) ?? r.reportCode,
        reportCode: r.reportCode,
        action: r.action,
        format: r.format,
        rowCount: r.rowCount,
        truncated: r.truncated,
        contentHash: r.contentHash,
        definitionsVersion: r.definitionsVersion,
        occurredAt: r.occurredAt.toISOString(),
      })),
      next: page.next,
    },
  };
}

/** What the hub needs to draw one report: words already in the viewer's language, nothing internal. */
export interface ReportListItem {
  code: string;
  title: string;
  question: string;
  family: FamilyCode;
  familyLabel: string;
  /** Where to open it: a screen of its own, or the generic report page. */
  href: string;
  keywords: readonly string[];
  /** True when the report can be downloaded, so the hub offers its page with the download buttons. */
  downloadable: boolean;
}

export type ListReportsResult = { ok: true; data: ReportListItem[] } | { ok: false; error: string };

/** The reports the signed-in person may open, every permission checked once. */
export async function listReportsAction(): Promise<ListReportsResult> {
  let userId: string;
  try {
    userId = await requireStaff();
  } catch {
    return { ok: false, error: 'Please sign in again to see reports.' };
  }
  // The Business Overview is the home screen, not an entry in the list of reports.
  const defs = (await getContainer().reportRunner.list(userId)).filter(
    (d) => d.view !== 'overview',
  );
  return {
    ok: true,
    data: defs.map((d) => ({
      code: d.code,
      title: plainText(d.titleId),
      question: plainText(d.questionId),
      family: d.family,
      familyLabel: plainText(FAMILY_LABELS[d.family]),
      href: d.href ?? `/admin/reports/${d.code}`,
      keywords: d.keywords,
      downloadable: d.exportFormats.length > 0,
    })),
  };
}
