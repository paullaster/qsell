'use server';

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { decisionLog, stockDocuments, stockLocations, users } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { canPermission } from '@/server/domains/access-control/guard';
import { isCountState } from '@/lib/stock-documents';
import { decodeCursor, encodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { PAGE_SIZE, searchText } from '@/server/domains/settings/paging';
import { idOf, objectOf, runStock } from './action-support';

const ROOT = '/admin/inventory/counts';

export interface CountRowView {
  id: string;
  number: string;
  state: string;
  locationCode: string;
  mode: string;
  blind: boolean;
  lines: number;
  counted: number;
  createdByName: string;
  createdAt: string;
}

export interface CountLineView {
  id: string;
  productId: string;
  productName: string;
  /** Hidden from the counter of a blind count until it is handed in. */
  expected: number | null;
  movedSince: number | null;
  counted: number | null;
  countedByName: string | null;
  countedAt: string | null;
  variance: number | null;
}

export interface CountStep {
  at: string;
  what: string;
  from: string | null;
  to: string | null;
  reason: string | null;
  by: string;
}

export interface CountDetail {
  id: string;
  number: string;
  state: string;
  mode: string;
  blind: boolean;
  note: string;
  location: { id: string; code: string; name: string };
  createdAt: string;
  lines: CountLineView[];
  steps: CountStep[];
  /** What the differences are worth together, and whether that needs a second person. */
  varianceValue: number;
  needsApproval: boolean;
  cancelReason: string | null;
  may: { count: boolean; approve: boolean };
}

const WORDS: Record<string, string> = { opened: 'Opened', handed_in: 'Handed in', reopened: 'Sent back to counting', approved: 'Approved', posted: 'Posted', cancelled: 'Cancelled' };

async function namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
  if (wanted.length === 0) return new Map();
  const rows = await drizzleDb.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Counts, newest first, a page at a time, with a search on the number and a filter by state. */
export async function stockCountsPageAction(input: unknown) {
  return await runStock('stock:read', async (ctx) => {
    const i = objectOf(input);
    const query = searchText({ query: typeof i.query === 'string' ? i.query : '' });
    const state = isCountState(i.state) ? i.state : null;
    const after = typeof i.cursor === 'string' && i.cursor !== '' ? decodeCursor(i.cursor) : null;
    const conditions: (SQL | undefined)[] = [
      eq(stockDocuments.companyId, ctx.companyId),
      eq(stockDocuments.kind, 'count'),
      state === null ? undefined : eq(stockDocuments.state, state),
      query === '' ? undefined : sql`${stockDocuments.number} ILIKE ${`%${escapeLike(query)}%`}`,
      after === null ? undefined : sql`(${stockDocuments.createdAt}, ${stockDocuments.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
    ];
    const rows = await drizzleDb
      .select({
        d: stockDocuments,
        key: sql<string>`to_char(${stockDocuments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        lines: sql<number>`(SELECT count(*)::int FROM stock_document_lines l WHERE l.document_id = stock_documents.id)`,
        counted: sql<number>`(SELECT count(*)::int FROM stock_document_lines l WHERE l.document_id = stock_documents.id AND l.counted_quantity IS NOT NULL)`,
        locationCode: sql<string>`(SELECT code FROM stock_locations WHERE id = ${stockDocuments.fromLocationId})`,
      })
      .from(stockDocuments)
      .where(and(...conditions))
      .orderBy(desc(stockDocuments.createdAt), desc(stockDocuments.id))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const names = await namesOf(page.map((r) => r.d.createdBy));
    const out: CountRowView[] = page.map((r) => ({
      id: r.d.id,
      number: r.d.number,
      state: r.d.state,
      locationCode: r.locationCode,
      mode: r.d.countMode ?? 'cycle',
      blind: r.d.blind,
      lines: r.lines,
      counted: r.counted,
      createdByName: names.get(r.d.createdBy) ?? r.d.createdBy,
      createdAt: r.d.createdAt.toISOString(),
    }));
    const ledgerOn = (await getContainer().stockSettings.get()).ledgerMode;
    return { rows: out, nextCursor: rows.length > PAGE_SIZE && last !== undefined ? encodeCursor({ k: last.key, id: last.d.id }) : null, ledgerOn };
  });
}

/** One count with its lines, its differences, its history and what this person may do to it. */
export async function stockCountAction(id: unknown) {
  return await runStock('stock:read', async (ctx): Promise<CountDetail> => {
    const [count, approve] = await Promise.all([canPermission('stock:count'), canPermission('stock:count_approve')]);
    // A blind count keeps its expected figures from those who only count; people who approve may see them.
    const view = await getContainer().stockCounts.get(ctx.companyId, idOf(id, 'count'), { asCounter: !approve });
    const doc = view.document;
    const [place] = await drizzleDb.select({ id: stockLocations.id, code: stockLocations.code, name: stockLocations.name }).from(stockLocations).where(eq(stockLocations.id, doc.fromLocationId ?? ''));
    const log = await drizzleDb.select().from(decisionLog).where(and(eq(decisionLog.companyId, ctx.companyId), eq(decisionLog.subjectType, 'stock_count'), eq(decisionLog.subjectId, doc.id))).orderBy(decisionLog.occurredAt);
    const names = await namesOf([...log.map((l) => l.actorId), ...view.lines.map((l) => l.line.countedBy)]);
    return {
      id: doc.id,
      number: doc.number,
      state: doc.state,
      mode: doc.countMode ?? 'cycle',
      blind: doc.blind,
      note: doc.note,
      location: place ?? { id: doc.fromLocationId ?? '', code: '?', name: 'Unknown location' },
      createdAt: doc.createdAt.toISOString(),
      lines: view.lines.map((l) => ({
        id: l.line.id,
        productId: l.line.productId,
        productName: l.productName,
        expected: l.expected,
        movedSince: l.movedSince,
        counted: l.line.countedQuantity,
        countedByName: l.line.countedBy === null ? null : (names.get(l.line.countedBy) ?? l.line.countedBy),
        countedAt: l.line.countedAt?.toISOString() ?? null,
        variance: l.variance,
      })),
      steps: log.map((l) => ({ at: l.occurredAt.toISOString(), what: WORDS[l.action.replace('stock.count.', '')] ?? l.action, from: l.fromState, to: l.toState, reason: l.reasonText, by: names.get(l.actorId ?? '') ?? l.actorId ?? 'The system' })),
      varianceValue: view.varianceValue,
      needsApproval: view.needsApproval,
      cancelReason: doc.cancelReason,
      may: { count, approve },
    };
  });
}

export async function openStockCountAction(input: unknown) {
  return await runStock('stock:count', async (ctx) => {
    const i = objectOf(input);
    return await getContainer().stockCounts.open(ctx.companyId, { id: ctx.userId }, {
      locationId: typeof i.locationId === 'string' ? i.locationId : '',
      mode: i.mode,
      blind: i.blind === true,
      productIds: i.productIds,
      note: typeof i.note === 'string' ? i.note : '',
    });
  }, [ROOT]);
}

export async function recordStockCountAction(id: unknown, entries: unknown) {
  return await runStock('stock:count', async (ctx) => {
    const lines = Array.isArray(entries) ? entries.map((e) => ({ productId: objectOf(e).productId, quantity: objectOf(e).quantity })) : [];
    return await getContainer().stockCounts.record(ctx.companyId, { id: ctx.userId }, idOf(id, 'count'), lines);
  }, [ROOT]);
}

export async function submitStockCountAction(id: unknown) {
  return await runStock('stock:count', async (ctx) => {
    await getContainer().stockCounts.submit(ctx.companyId, { id: ctx.userId }, idOf(id, 'count'));
    return { done: true };
  }, [ROOT]);
}

export async function reopenStockCountAction(id: unknown) {
  return await runStock('stock:count', async (ctx) => {
    await getContainer().stockCounts.reopen(ctx.companyId, { id: ctx.userId }, idOf(id, 'count'));
    return { done: true };
  }, [ROOT]);
}

export async function approveStockCountAction(id: unknown) {
  return await runStock('stock:count_approve', async (ctx) => {
    await getContainer().stockCounts.approve(ctx.companyId, { id: ctx.userId }, idOf(id, 'count'));
    return { done: true };
  }, [ROOT]);
}

export async function postStockCountAction(id: unknown) {
  return await runStock('stock:count_approve', async (ctx) => {
    return await getContainer().stockCounts.post(ctx.companyId, { id: ctx.userId }, idOf(id, 'count'));
  }, [ROOT]);
}

export async function cancelStockCountAction(id: unknown, reason: unknown) {
  return await runStock('stock:count', async (ctx) => {
    await getContainer().stockCounts.cancel(ctx.companyId, { id: ctx.userId }, idOf(id, 'count'), reason);
    return { done: true };
  }, [ROOT]);
}
