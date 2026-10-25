'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { RgnHeaderForm, RgnLineForm } from '@/lib/rgn';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

export async function rgnListAction(filter: { status?: string; before?: { createdAt: string; id: string } | null } = {}) {
  return await run('rgn:read', { surface: 'rgn/list', action: 'view' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.createdAt.length <= 40 ? filter.before : null;
    const page = await getContainer().rgns.list(ctx.companyId, { status: has(filter.status) ? str(filter.status, 20) : undefined, before });
    return {
      rows: page.rows.map((r) => ({ id: r.id, number: r.number, status: r.status, vendorName: r.vendorName, poNumber: r.poNumber, deliveryNoteNo: r.deliveryNoteNo, receivedDate: r.receivedDate })),
      next: page.next,
    };
  });
}

/** A note for editing or reading: the note (if any), and the order's lines with what is still to come. */
export async function rgnAction(rgnId: string | null, poId: string | null) {
  return await run('rgn:read', { surface: 'rgn/view', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const note = rgnId === null ? null : await container.rgns.get(ctx.companyId, id(rgnId));
    if (rgnId !== null && note === null) throw new FinanceError('NOT_FOUND', 'That received goods note does not exist.');
    const orderId = note?.rgn.poId ?? (poId === null ? null : id(poId));
    if (orderId === null) throw new FinanceError('NOT_FOUND', 'Choose the order the goods arrived against.');
    const out = await container.rgns.outstanding(ctx.companyId, orderId);
    const [create, post, reverse] = await Promise.all([canPermission('rgn:create'), canPermission('rgn:post'), canPermission('rgn:reverse')]);
    return {
      id: note?.rgn.id ?? null,
      number: note?.rgn.number ?? null,
      status: note?.rgn.status ?? 'draft',
      po: { id: out.po.id, number: out.po.number, status: out.po.status, vendorId: out.po.vendorId },
      vendorName: note?.vendorName ?? null,
      form: { receivedDate: note?.rgn.receivedDate ?? businessDate(), deliveryNoteNo: note?.rgn.deliveryNoteNo ?? '', vehicle: note?.rgn.vehicle ?? '', notes: note?.rgn.notes ?? '' } satisfies RgnHeaderForm,
      reverseReason: note?.rgn.reverseReason ?? null,
      lines: out.lines.map((l) => {
        const mine = note?.lines.find((x) => x.l.poLineId === l.id)?.l;
        return { ...l, delivered: mine?.delivered ?? '', rejected: mine === undefined || Number(mine.rejected) === 0 ? '' : mine.rejected, rejectReason: mine?.rejectReason ?? '', accepted: mine?.accepted ?? null };
      }),
      can: { create, post, reverse },
    };
  });
}

export async function saveRgnAction(rgnId: string | null, poId: string, header: unknown, lines: unknown) {
  return await run('rgn:create', { surface: 'rgn/edit', action: rgnId === null ? 'create' : 'update' }, async (ctx) => {
    const h = obj(header);
    const clean: RgnHeaderForm = { receivedDate: str(h.receivedDate, 12), deliveryNoteNo: str(h.deliveryNoteNo, 80), vehicle: str(h.vehicle, 80), notes: str(h.notes, 2000) };
    const rows: RgnLineForm[] = (Array.isArray(lines) ? lines.slice(0, 300) : []).map((x) => {
      const l = obj(x);
      return { poLineId: id(l.poLineId), delivered: str(l.delivered, 20), rejected: str(l.rejected, 20), rejectReason: str(l.rejectReason, 30) };
    });
    return await getContainer().rgns.saveDraft(ctx, rgnId === null ? null : id(rgnId), id(poId), clean, rows);
  }, ['/admin/vendors/receipts']);
}

export async function postRgnAction(rgnId: string) {
  return await run('rgn:post', { surface: 'rgn/edit', action: 'post' }, async (ctx) => await getContainer().rgns.post(ctx, id(rgnId)), ['/admin/vendors/receipts', '/admin/vendors/orders']);
}

export async function cancelRgnDraftAction(rgnId: string) {
  return await run('rgn:create', { surface: 'rgn/edit', action: 'cancel_draft' }, async (ctx) => {
    await getContainer().rgns.cancelDraft(ctx, id(rgnId));
  }, ['/admin/vendors/receipts']);
}

export async function reverseRgnAction(rgnId: string, reason: string) {
  return await run('rgn:reverse', { surface: 'rgn/edit', action: 'reverse' }, async (ctx) => {
    await getContainer().rgns.reverse(ctx, id(rgnId), str(reason));
  }, ['/admin/vendors/receipts', '/admin/vendors/orders']);
}

export async function notInvoicedAction() {
  return await run('rgn:read', { surface: 'rgn/report', action: 'not_invoiced' }, async (ctx) => await getContainer().rgns.notInvoiced(ctx.companyId, businessDate()));
}
