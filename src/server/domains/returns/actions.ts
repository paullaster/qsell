'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { ReturnError, type ConfirmItem, type ReturnActor } from './return-receipt-service';
import { injectedDelay } from '@/server/domains/finance/action-runner';
import { suggestedDisposition } from '@/server/domains/finance/domain/credit-note-accounting';

export type ReturnResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; forbidden?: true };

const ROOT = '/admin/finance/receivables/returns';

async function run<T>(permission: PermissionKey, origin: { surface: string; action: string }, fn: (a: ReturnActor) => Promise<T>, paths: string[] = []): Promise<ReturnResult<T>> {
  try {
    await injectedDelay();
    const userId = await requirePermission(permission);
    const company = await getContainer().companySettings.ensureSeeded();
    await getContainer().reasonCodes.ensureSystemReasons(company.id);
    const h = await headers();
    const data = await fn({ companyId: company.id, actorId: userId, origin: { ...origin, permissionUsed: permission, ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') } });
    for (const p of paths) revalidatePath(p);
    return { ok: true, data };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    if (error instanceof ReturnError || error instanceof ReasonError) return { ok: false, error: error.message, code: error.code };
    console.error('[returns]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

export async function listReturnsAction(filter: 'open' | 'closed' = 'open') {
  return run('return_receipts:read', { surface: 'returns', action: 'list' }, async (a) => {
    const rows = await getContainer().returns.list(a.companyId, filter);
    return {
      rows: rows.map((r) => ({
        id: r.r.id,
        number: r.r.number,
        status: r.r.status,
        creditNoteNo: r.creditNoteNo,
        order: r.sourceRef,
        reason: r.reasonCode,
        expected: r.expected,
        received: r.received,
        requestedAt: r.r.createdAt.toISOString(),
        closedAt: r.r.closedAt ? r.r.closedAt.toISOString() : null,
      })),
    };
  });
}

export async function returnDetailAction(id: string) {
  return run('return_receipts:read', { surface: 'returns/detail', action: 'view' }, async (a) => {
    const d = await getContainer().returns.detail(a.companyId, id);
    if (!d) throw new ReturnError('NOT_FOUND', 'That return does not exist.');
    const names = new Map(d.lines.map((l) => [l.id, l.description]));
    return {
      id: d.r.id,
      number: d.r.number,
      status: d.r.status,
      creditNoteNo: d.creditNoteNo,
      order: d.sourceRef,
      reason: d.reasonCode,
      suggested: suggestedDisposition(d.reasonCode),
      closed: d.r.closedAt !== null,
      closeReason: d.r.closeReasonCode,
      closeText: d.r.closeReasonText,
      lines: d.lines.map((l) => ({ id: l.id, productId: l.productId, description: l.description, expected: l.expectedQty, received: l.receivedQty, unitCost: l.unitCost })),
      confirmations: d.confirmations.map((c) => ({ id: String(c.id), line: names.get(c.lineId) ?? '', quantity: c.quantity, condition: c.condition, disposition: c.disposition, stockAdded: c.stockAdded, note: c.note, by: c.confirmedBy, at: c.createdAt.toISOString() })),
      can: { confirm: await canPermission('restock:confirm'), reject: await canPermission('restock:reject') },
    };
  });
}

export async function confirmReturnAction(id: string, items: ConfirmItem[]) {
  return run('restock:confirm', { surface: 'returns/detail', action: 'confirm' }, async (a) => getContainer().returns.confirm(a, id, items), [ROOT, `${ROOT}/${id}`, '/admin/inventory']);
}

export async function closeReturnAction(id: string, reason: { code: string; text?: string }) {
  return run('restock:reject', { surface: 'returns/detail', action: 'close' }, async (a) => getContainer().returns.close(a, id, reason), [ROOT, `${ROOT}/${id}`]);
}
