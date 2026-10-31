'use server';

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { decisionLog, stockDocuments, stockLocations, stockSettings, users } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { canPermission } from '@/server/domains/access-control/guard';
import { TRANSFER_STATES, isTransferState } from '@/lib/stock-documents';
import { decodeCursor, encodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { PAGE_SIZE, searchText } from '@/server/domains/settings/paging';
import { idOf, objectOf, runStock } from './action-support';
import { StockError } from './errors';

const ROOT = '/admin/inventory/transfers';

export interface TransferRowView {
  id: string;
  number: string;
  state: string;
  fromCode: string;
  toCode: string;
  lines: number;
  createdByName: string;
  createdAt: string;
  shippedAt: string | null;
}

export interface TransferLineView {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  shippedQuantity: number;
  receivedQuantity: number;
  writtenOffQuantity: number;
  returnedQuantity: number;
  inTransit: number;
}

export interface TransferStep {
  at: string;
  what: string;
  from: string | null;
  to: string | null;
  reason: string | null;
  by: string;
}

export interface TransferDetail {
  id: string;
  number: string;
  state: string;
  version: number;
  fromLocation: { id: string; code: string; name: string };
  toLocation: { id: string; code: string; name: string };
  note: string;
  createdAt: string;
  lines: TransferLineView[];
  steps: TransferStep[];
  cancelReason: string | null;
  /** The company wants a second person to approve before a transfer is shipped. */
  approvalRequired: boolean;
  /** What the person looking may do, from their own permissions. */
  may: { request: boolean; approve: boolean; ship: boolean; receive: boolean };
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** User ids as names, for many at once. A person who has gone shows as their id. */
async function namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
  if (wanted.length === 0) return new Map();
  const rows = await drizzleDb.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const WORDS: Record<string, string> = {
  created: 'Created', changed: 'Changed', requested: 'Asked for', approved: 'Approved', shipped: 'Sent', received: 'Received', settled: 'Settled what did not arrive', cancelled: 'Cancelled',
};

/** Transfers, newest first, a page at a time, with a search on the number and a filter by state. */
export async function stockTransfersPageAction(input: unknown) {
  return await runStock('stock:read', async (ctx) => {
    const i = objectOf(input);
    const query = searchText({ query: typeof i.query === 'string' ? i.query : '' });
    const state = isTransferState(i.state) ? i.state : null;
    const after = typeof i.cursor === 'string' && i.cursor !== '' ? decodeCursor(i.cursor) : null;
    const conditions: (SQL | undefined)[] = [
      eq(stockDocuments.companyId, ctx.companyId),
      eq(stockDocuments.kind, 'transfer'),
      state === null ? undefined : eq(stockDocuments.state, state),
      query === '' ? undefined : sql`${stockDocuments.number} ILIKE ${`%${escapeLike(query)}%`}`,
      after === null ? undefined : sql`(${stockDocuments.createdAt}, ${stockDocuments.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
    ];
    const rows = await drizzleDb
      .select({
        d: stockDocuments,
        key: sql<string>`to_char(${stockDocuments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        lines: sql<number>`(SELECT count(*)::int FROM stock_document_lines l WHERE l.document_id = ${stockDocuments.id})`,
        fromCode: sql<string>`(SELECT code FROM stock_locations WHERE id = ${stockDocuments.fromLocationId})`,
        toCode: sql<string>`(SELECT code FROM stock_locations WHERE id = ${stockDocuments.toLocationId})`,
      })
      .from(stockDocuments)
      .where(and(...conditions))
      .orderBy(desc(stockDocuments.createdAt), desc(stockDocuments.id))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const names = await namesOf(page.map((r) => r.d.createdBy));
    const out: TransferRowView[] = page.map((r) => ({
      id: r.d.id,
      number: r.d.number,
      state: r.d.state,
      fromCode: r.fromCode,
      toCode: r.toCode,
      lines: r.lines,
      createdByName: names.get(r.d.createdBy) ?? r.d.createdBy,
      createdAt: r.d.createdAt.toISOString(),
      shippedAt: iso(r.d.shippedAt),
    }));
    const ledgerOn = (await getContainer().stockSettings.get()).ledgerMode;
    return { rows: out, nextCursor: rows.length > PAGE_SIZE && last !== undefined ? encodeCursor({ k: last.key, id: last.d.id }) : null, states: [...TRANSFER_STATES], ledgerOn };
  });
}

/** One transfer with its lines, its history and what this person may do to it. */
export async function stockTransferAction(id: unknown) {
  return await runStock('stock:read', async (ctx): Promise<TransferDetail> => {
    const view = await getContainer().stockTransfers.get(ctx.companyId, idOf(id, 'transfer'));
    const doc = view.document;
    const places = await drizzleDb.select({ id: stockLocations.id, code: stockLocations.code, name: stockLocations.name }).from(stockLocations).where(inArray(stockLocations.id, [doc.fromLocationId ?? '', doc.toLocationId ?? '']));
    const place = (pid: string | null) => places.find((p) => p.id === pid) ?? { id: pid ?? '', code: '?', name: 'Unknown location' };
    const log = await drizzleDb.select().from(decisionLog).where(and(eq(decisionLog.companyId, ctx.companyId), eq(decisionLog.subjectType, 'stock_transfer'), eq(decisionLog.subjectId, doc.id))).orderBy(decisionLog.occurredAt);
    const names = await namesOf([doc.createdBy, ...log.map((l) => l.actorId)]);
    const [settings] = await drizzleDb.select({ approval: stockSettings.transferRequiresApproval }).from(stockSettings).where(eq(stockSettings.companyId, ctx.companyId)).limit(1);
    const [request, approve, ship, receive] = await Promise.all([canPermission('stock:transfer_request'), canPermission('stock:transfer_approve'), canPermission('stock:transfer_ship'), canPermission('stock:transfer_receive')]);
    return {
      id: doc.id,
      number: doc.number,
      state: doc.state,
      version: doc.version,
      fromLocation: place(doc.fromLocationId),
      toLocation: place(doc.toLocationId),
      note: doc.note,
      createdAt: doc.createdAt.toISOString(),
      lines: view.lines.map((l) => ({ id: l.id, productId: l.productId, productName: l.productName, quantity: l.quantity, shippedQuantity: l.shippedQuantity, receivedQuantity: l.receivedQuantity, writtenOffQuantity: l.writtenOffQuantity, returnedQuantity: l.returnedQuantity, inTransit: l.inTransit })),
      steps: log.map((l) => ({ at: l.occurredAt.toISOString(), what: WORDS[l.action.replace('stock.transfer.', '')] ?? l.action, from: l.fromState, to: l.toState, reason: l.reasonText, by: names.get(l.actorId ?? '') ?? l.actorId ?? 'The system' })),
      cancelReason: doc.cancelReason,
      approvalRequired: settings?.approval === true,
      may: { request, approve, ship, receive },
    };
  });
}

const numbers = (raw: unknown): { productId: unknown; quantity: unknown }[] =>
  Array.isArray(raw) ? raw.map((l) => ({ productId: objectOf(l).productId, quantity: objectOf(l).quantity })) : [];

const inputOf = (raw: unknown) => {
  const i = objectOf(raw);
  return { fromLocationId: typeof i.fromLocationId === 'string' ? i.fromLocationId : '', toLocationId: typeof i.toLocationId === 'string' ? i.toLocationId : '', note: typeof i.note === 'string' ? i.note : '', lines: numbers(i.lines) };
};

export async function createStockTransferAction(input: unknown) {
  return await runStock('stock:transfer_request', async (ctx) => {
    const made = await getContainer().stockTransfers.create(ctx.companyId, { id: ctx.userId }, inputOf(input));
    return made;
  }, [ROOT]);
}

export async function updateStockTransferAction(id: unknown, expectedVersion: unknown, input: unknown) {
  return await runStock('stock:transfer_request', async (ctx) => {
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) throw new StockError('Open the transfer again before saving.', 'CHANGED');
    await getContainer().stockTransfers.updateDraft(ctx.companyId, { id: ctx.userId }, idOf(id, 'transfer'), expectedVersion, inputOf(input));
    return { done: true };
  }, [ROOT]);
}

export async function requestStockTransferAction(id: unknown) {
  return await runStock('stock:transfer_request', async (ctx) => {
    await getContainer().stockTransfers.request(ctx.companyId, { id: ctx.userId }, idOf(id, 'transfer'));
    return { done: true };
  }, [ROOT]);
}

export async function approveStockTransferAction(id: unknown) {
  return await runStock('stock:transfer_approve', async (ctx) => {
    await getContainer().stockTransfers.approve(ctx.companyId, { id: ctx.userId }, idOf(id, 'transfer'));
    return { done: true };
  }, [ROOT]);
}

export async function cancelStockTransferAction(id: unknown, reason: unknown) {
  return await runStock('stock:transfer_request', async (ctx) => {
    await getContainer().stockTransfers.cancel(ctx.companyId, { id: ctx.userId }, idOf(id, 'transfer'), reason);
    return { done: true };
  }, [ROOT]);
}

const entriesOf = (raw: unknown): { lineId: string; quantity: number; action?: unknown }[] =>
  Array.isArray(raw)
    ? raw.map((e) => {
        const o = objectOf(e);
        return { lineId: idOf(o.lineId, 'line'), quantity: typeof o.quantity === 'number' ? o.quantity : Number.NaN, action: o.action };
      })
    : [];

export async function shipStockTransferAction(id: unknown, lines: unknown) {
  return await runStock('stock:transfer_ship', async (ctx) => {
    const given = lines === undefined || lines === null ? undefined : entriesOf(lines).map((e) => ({ lineId: e.lineId, quantity: e.quantity }));
    return await getContainer().stockTransfers.ship(ctx.companyId, { id: ctx.userId }, idOf(id, 'transfer'), given);
  }, [ROOT]);
}

export async function receiveStockTransferAction(id: unknown, lines: unknown) {
  return await runStock('stock:transfer_receive', async (ctx) => {
    const entries = entriesOf(lines).map((e) => ({ lineId: e.lineId, quantity: e.quantity }));
    return await getContainer().stockTransfers.receive(ctx.companyId, { id: ctx.userId }, idOf(id, 'transfer'), entries);
  }, [ROOT]);
}

export async function resolveStockTransferAction(id: unknown, lines: unknown, reason: unknown) {
  return await runStock('stock:transfer_ship', async (ctx) => {
    const entries = entriesOf(lines).map((e) => ({ lineId: e.lineId, quantity: e.quantity, action: e.action as 'write_off' | 'return_to_source' }));
    return await getContainer().stockTransfers.resolve(ctx.companyId, { id: ctx.userId }, idOf(id, 'transfer'), entries, reason);
  }, [ROOT]);
}
