'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { getContainer } from '@/server/di/container';
import { ReasonError } from '../reason-codes/service';
import { isMalformedId, NO_SUCH_RECORD } from '@/server/domains/settings/errors';
import { DOCUMENT_KINDS, DOCUMENT_KIND_LIST, isDocumentKind, type DocumentKind } from './document-kinds';
import { NumberSeriesError, type LineInput, type NumberPreview, type SeriesInput } from './service';
import type { Issue } from './domain/types';

import { emptyToNull, has } from '@/lib/values';
import { injectedDelay } from '@/server/domains/finance/action-runner';
import { businessDate } from './business-date';
import type { PageInput } from '@/server/domains/settings/paging';

const PAGE = '/admin/settings/number-series';

export type NumberingResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; issues?: Issue[]; forbidden?: true };

/** Server action errors are masked in production, so failures come back as data. */
async function run<T>(
  fn: (ctx: { companyId: string; actor: { type: 'user'; id: string } }) => Promise<T>,
): Promise<NumberingResult<T>> {
  try {
    await injectedDelay();
    const userId = await requirePermission('numbering:manage');
    const company = await getContainer().companySettings.ensureSeeded();
    await getContainer().reasonCodes.ensureSystemReasons(company.id);
    return {
      ok: true,
      data: await fn({ companyId: company.id, actor: { type: 'user', id: userId } }),
    };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return {
        ok: false,
        error: 'You do not have permission to manage number series.',
        forbidden: true,
      };
    }
    if (error instanceof NumberSeriesError) {
      return { ok: false, error: error.message, code: error.code, issues: error.detail.issues };
    }
    if (error instanceof ReasonError) return { ok: false, error: error.message, code: error.code };
    if (isMalformedId(error)) return NO_SUCH_RECORD;
    console.error('[numbering]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

const today = () => businessDate();

/** The name of a kind of document; a kind this code no longer knows keeps its stored name. */
const kindLabel = (kind: string): string => (isDocumentKind(kind) ? DOCUMENT_KINDS[kind].label : kind);

// ── views ────────────────────────────────────────────────────────────────

export interface SeriesSummary {
  id: string;
  code: string;
  description: string;
  mode: 'gap_free' | 'allow_gaps';
  isActive: boolean;
  lineCount: number;
  nextExample: string | null;
  nextProblem: string | null;
  boundTo: { kind: DocumentKind; label: string; branchCode: string | null }[];
}

export interface LineView {
  id: string;
  lineNo: number;
  branchId: string | null;
  branchCode: string | null;
  branchLabel: string | null;
  startsOn: string;
  endsOn: string | null;
  prefix: string;
  suffix: string;
  digits: number;
  startNo: number;
  endNo: number | null;
  increment: number;
  warnAt: number | null;
  reset: 'never' | 'yearly' | 'monthly';
  isOpen: boolean;
  /** Has issued numbers: its structure is frozen. */
  used: boolean;
  lastNo: number | null;
  lastPeriod: string | null;
}

export interface SeriesDetailView {
  series: {
    id: string;
    code: string;
    description: string;
    mode: 'gap_free' | 'allow_gaps';
    manualAllowed: boolean;
    defaultNumbers: boolean;
    dateOrder: boolean;
    blockSize: number;
    isActive: boolean;
  };
  lines: LineView[];
  /** Fiscal kinds bound here: they pin the series to gap-free. */
  fiscalKinds: string[];
  boundTo: SeriesSummary['boundTo'];
  recent: {
    number: string;
    documentKind: string | null;
    documentId: string | null;
    source: string;
    documentDate: string;
    allocatedAt: string;
    allocatedBy: string | null;
  }[];
  history: {
    at: string;
    action: string;
    actor: string | null;
    reasonCode: string | null;
    reasonText: string | null;
    detail: Record<string, unknown>;
  }[];
}

export interface BindingsView {
  kinds: { kind: DocumentKind; label: string; fiscal: boolean }[];
  /** Where each kind is bound: the series (with the words to show for it) and the branch, if for one branch only. */
  bindings: { documentKind: string; branchId: string | null; branchLabel: string | null; seriesId: string; seriesLabel: string }[];
  /** What each kind would be numbered as, if used today with no branch. */
  examples: Record<string, string | null>;
}

/** One page of the series in code order, each with its next number and the documents it numbers. */
export async function numberSeriesPageAction(
  input: PageInput,
): Promise<NumberingResult<{ rows: SeriesSummary[]; nextCursor: string | null }>> {
  return run(async ({ companyId }) => {
    const { numbering } = getContainer();
    const page = await numbering.pageSeries(companyId, input);
    const branchIds = [...new Set(page.bindings.flatMap((b) => (b.branchId === null ? [] : [b.branchId])))];
    const branchCode = await numbering.branchCodes(branchIds);
    const rows = await Promise.all(
      page.rows.map(async (s): Promise<SeriesSummary> => {
        const preview = await numbering.preview(companyId, { seriesCode: s.code }, { date: today() });
        return {
          id: s.id,
          code: s.code,
          description: s.description,
          mode: s.mode,
          isActive: s.isActive,
          lineCount: page.lineCounts.get(s.id) ?? 0,
          nextExample: preview.number,
          nextProblem: preview.error?.message ?? null,
          boundTo: page.bindings
            .filter((b) => b.seriesId === s.id)
            .map((b) => ({
              kind: b.documentKind as DocumentKind,
              label: kindLabel(b.documentKind),
              branchCode: b.branchId === null ? null : (branchCode.get(b.branchId) ?? null),
            })),
        };
      }),
    );
    return { rows, nextCursor: page.nextCursor };
  });
}

export async function getNumberSeriesAction(
  id: string,
): Promise<NumberingResult<SeriesDetailView>> {
  return run(async ({ companyId }) => {
    const { numbering, decisionLog } = getContainer();
    const [detail, recent, history] = await Promise.all([
      numbering.seriesDetail(companyId, id),
      numbering.recentAllocations(companyId, id, 30),
      decisionLog.timeline('number_series', id, 60),
    ]);
    const bound = [...detail.lines.flatMap(({ line }) => (line.branchId === null ? [] : [line.branchId])), ...detail.bindings.flatMap((b) => (b.branchId === null ? [] : [b.branchId]))];
    const branchLabel = await numbering.branchLabels([...new Set(bound)]);
    const latest = new Map<string, { lastNo: number | null; periodKey: string }>();
    for (const c of detail.counters)
      if (!latest.has(c.lineId)) latest.set(c.lineId, { lastNo: c.lastNo, periodKey: c.periodKey });
    const used = new Set(detail.counters.map((c) => c.lineId));
    const branchCode = await numbering.branchCodes([...new Set(bound)]);
    return {
      series: {
        id: detail.series.id,
        code: detail.series.code,
        description: detail.series.description,
        mode: detail.series.mode,
        manualAllowed: detail.series.manualAllowed,
        defaultNumbers: detail.series.defaultNumbers,
        dateOrder: detail.series.dateOrder,
        blockSize: detail.series.blockSize,
        isActive: detail.series.isActive,
      },
      lines: detail.lines.map(({ line, branchCode: code }) => ({
        id: line.id,
        lineNo: line.lineNo,
        branchId: line.branchId,
        branchCode: code,
        branchLabel: line.branchId === null ? null : (branchLabel.get(line.branchId) ?? null),
        startsOn: line.startsOn,
        endsOn: line.endsOn,
        prefix: line.prefix,
        suffix: line.suffix,
        digits: line.digits,
        startNo: line.startNo,
        endNo: line.endNo,
        increment: line.increment,
        warnAt: line.warnAt,
        reset: line.reset,
        isOpen: line.isOpen,
        used: used.has(line.id),
        lastNo: latest.get(line.id)?.lastNo ?? null,
        lastPeriod: emptyToNull(latest.get(line.id)?.periodKey),
      })),
      fiscalKinds: detail.bindings
        .map((b) => b.documentKind as DocumentKind)
        .filter((k) => DOCUMENT_KINDS[k].fiscal)
        .map((k) => DOCUMENT_KINDS[k].label),
      boundTo: detail.bindings.map((b) => ({
        kind: b.documentKind as DocumentKind,
        label: kindLabel(b.documentKind),
        branchCode: has(b.branchId) ? (branchCode.get(b.branchId) ?? null) : null,
      })),
      recent: recent.map((r) => ({
        number: r.number,
        documentKind: r.documentKind,
        documentId: r.documentId,
        source: r.source,
        documentDate: r.documentDate,
        allocatedAt: r.allocatedAt.toISOString(),
        allocatedBy: r.allocatedBy,
      })),
      history: history
        .map((h) => ({
          at: h.occurredAt.toISOString(),
          action: h.action,
          actor: h.actorId,
          reasonCode: h.reasonCode,
          reasonText: h.reasonText,
          detail: h.inputs,
        }))
        .reverse(),
    };
  });
}

export async function getBindingsAction(): Promise<NumberingResult<BindingsView>> {
  return run(async ({ companyId }) => {
    const { numbering } = getContainer();
    const bindings = await numbering.bindings(companyId);
    const seriesIds = [...new Set(bindings.map((b) => b.seriesId))];
    const branchIds = [...new Set(bindings.flatMap((b) => (b.branchId === null ? [] : [b.branchId])))];
    const [seriesLabels, branchLabels, examples] = await Promise.all([
      numbering.seriesLabels(companyId, seriesIds),
      numbering.branchLabels(branchIds),
      Promise.all(DOCUMENT_KIND_LIST.map(async (kind) => [kind, (await numbering.preview(companyId, { kind }, { date: today() })).number] as const)),
    ]);
    return {
      kinds: DOCUMENT_KIND_LIST.map((kind) => ({
        kind,
        label: DOCUMENT_KINDS[kind].label,
        fiscal: DOCUMENT_KINDS[kind].fiscal,
      })),
      bindings: bindings.map((b) => ({
        documentKind: b.documentKind,
        branchId: b.branchId,
        branchLabel: b.branchId === null ? null : (branchLabels.get(b.branchId) ?? null),
        seriesId: b.seriesId,
        seriesLabel: seriesLabels.get(b.seriesId) ?? b.seriesId,
      })),
      examples: Object.fromEntries(examples),
    };
  });
}

export async function previewNumberAction(input: {
  seriesCode?: string;
  kind?: string;
  branchId?: string | null;
  date: string;
}): Promise<NumberingResult<NumberPreview>> {
  return run(async ({ companyId }) => {
    const target = has(input.seriesCode) ? { seriesCode: input.seriesCode } : { kind: input.kind ?? '' };
    return getContainer().numbering.preview(companyId, target, {
      branchId: input.branchId ?? null,
      date: input.date,
    });
  });
}

// ── changes ──────────────────────────────────────────────────────────────

interface Reason { code?: string | null; text?: string | null }

export async function createNumberSeriesAction(
  input: SeriesInput,
): Promise<NumberingResult<{ id: string }>> {
  return run(async ({ companyId, actor }) => {
    const s = await getContainer().numbering.createSeries(companyId, input, actor);
    revalidatePath(PAGE);
    return { id: s.id };
  });
}

export async function updateNumberSeriesAction(
  id: string,
  patch: Parameters<ReturnType<typeof getContainer>['numbering']['updateSeries']>[2],
  reason: Reason,
): Promise<NumberingResult<true>> {
  return run(async ({ companyId, actor }) => {
    await getContainer().numbering.updateSeries(companyId, id, patch, actor, reason);
    revalidatePath(PAGE);
    return true as const;
  });
}

export async function deleteNumberSeriesAction(
  id: string,
  reason: Reason,
): Promise<NumberingResult<true>> {
  return run(async ({ companyId, actor }) => {
    await getContainer().numbering.deleteSeries(companyId, id, actor, reason);
    revalidatePath(PAGE);
    return true as const;
  });
}

export async function addNumberSeriesLineAction(
  seriesId: string,
  input: LineInput,
): Promise<NumberingResult<true>> {
  return run(async ({ companyId, actor }) => {
    await getContainer().numbering.addLine(companyId, seriesId, input, actor);
    revalidatePath(PAGE);
    return true as const;
  });
}

export async function updateNumberSeriesLineAction(
  lineId: string,
  patch: Partial<LineInput>,
  reason: Reason,
): Promise<NumberingResult<true>> {
  return run(async ({ companyId, actor }) => {
    await getContainer().numbering.updateLine(companyId, lineId, patch, actor, reason);
    revalidatePath(PAGE);
    return true as const;
  });
}

export async function setNumberSeriesLineOpenAction(
  lineId: string,
  open: boolean,
  reason: Reason,
): Promise<NumberingResult<true>> {
  return run(async ({ companyId, actor }) => {
    await getContainer().numbering.setLineOpen(companyId, lineId, open, actor, reason);
    revalidatePath(PAGE);
    return true as const;
  });
}

export async function setNumberBindingAction(
  input: { documentKind: string; branchId?: string | null; seriesId: string },
  reason: Reason,
): Promise<NumberingResult<true>> {
  return run(async ({ companyId, actor }) => {
    await getContainer().numbering.setBinding(companyId, input, actor, reason);
    revalidatePath(PAGE);
    return true as const;
  });
}

export async function clearNumberBindingAction(
  documentKind: string,
  branchId: string | null,
  reason: Reason,
): Promise<NumberingResult<true>> {
  return run(async ({ companyId, actor }) => {
    await getContainer().numbering.clearBinding(companyId, documentKind, branchId, actor, reason);
    revalidatePath(PAGE);
    return true as const;
  });
}

export async function seedStandardNumberSeriesAction(): Promise<
  NumberingResult<{ created: string[] }>
> {
  return run(async ({ companyId, actor }) => {
    const result = await getContainer().numbering.seedStandard(companyId, actor, today());
    revalidatePath(PAGE);
    return result;
  });
}
