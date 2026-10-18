'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { postingPermissions, run } from './action-runner';
import { FinanceError } from './errors';
import type { GenerateInput } from './receivables/refund-file-service';
import type { RefundFileStatus } from '@/server/db/drizzle/schema';

import { has } from '@/lib/values';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance/refunds/files';

/** Approved bank-transfer refunds not yet in a file, ready to be chosen. */
export async function refundFileCandidatesAction(currency?: string) {
  return await run('refund_files:read', { surface: 'finance/refunds/files', action: 'candidates' }, async (ctx, userId) => {
    const rows = await fin().refundFiles.candidates(ctx.companyId, { currency });
    return {
      me: userId,
      rows: rows.map((x) => ({ id: x.r.id, number: x.r.number, customer: x.customerName, amount: x.r.amount, currency: x.r.currency, approvedAt: x.r.approvedAt ? x.r.approvedAt.toISOString() : null, approvedBy: x.r.approvedBy })),
      can: { generate: await canPermission('refund_files:generate') },
    };
  });
}

export async function generateRefundFileAction(input: GenerateInput) {
  return await run('refund_files:generate', { surface: 'finance/refunds/files', action: 'generate' }, async (ctx) => await fin().refundFiles.generate(ctx, input), [ROOT, '/admin/finance/refunds']);
}

export async function confirmRefundFileAction(id: string, input: { bankReference: string; paidOn?: string }) {
  return await run('refund_files:confirm', { surface: 'finance/refunds/files/detail', action: 'confirm' }, async (ctx) => await fin().refundFiles.confirm(ctx, id, { ...input, permissions: await postingPermissions() }), [ROOT, `${ROOT}/${id}`, '/admin/finance/refunds']);
}

export async function cancelRefundFileAction(id: string, reason: { code: string; text?: string }) {
  return await run('refund_files:cancel', { surface: 'finance/refunds/files/detail', action: 'cancel' }, async (ctx) => {
    await fin().refundFiles.cancel(ctx, id, reason);
    return { id };
  }, [ROOT, `${ROOT}/${id}`, '/admin/finance/refunds']);
}

export async function listRefundFilesAction(filter: { status?: RefundFileStatus } = {}) {
  return await run('refund_files:read', { surface: 'finance/refunds/files', action: 'list' }, async (ctx) => {
    const rows = await fin().refundFiles.list(ctx.companyId, filter);
    return {
      rows: rows.map((f) => ({ id: f.id, number: f.number, format: f.format, currency: f.currency, total: f.total, count: f.itemCount, status: f.status, downloads: f.downloads, createdAt: f.createdAt.toISOString() })),
      can: { generate: await canPermission('refund_files:generate') },
    };
  });
}

export async function refundFileDetailAction(id: string) {
  return await run('refund_files:read', { surface: 'finance/refunds/files/detail', action: 'view' }, async (ctx, userId) => {
    const d = await fin().refundFiles.detail(ctx.companyId, id);
    if (!d) throw new FinanceError('NOT_FOUND', 'That payment file does not exist.');
    const f = d.f;
    const name = (x: string | null) => (has(x) ? (d.actors[x] ?? x) : null);
    const media = getContainer().media;
    const attachments = await Promise.all(d.attachments.map(async (a) => ({ id: a.id, fileName: a.fileName, note: a.note, createdAt: a.createdAt.toISOString(), url: await media.deliveryUrlById(a.mediaAssetId).catch(() => null) })));
    return {
      id: f.id,
      number: f.number,
      format: f.format,
      currency: f.currency,
      total: f.total,
      count: f.itemCount,
      status: f.status,
      method: d.method,
      downloads: f.downloads,
      fingerprint: f.contentSha256,
      createdBy: name(f.createdBy),
      createdAt: f.createdAt.toISOString(),
      confirmedBy: name(f.confirmedBy),
      bankReference: f.bankReference,
      cancelReason: f.cancelReason,
      items: d.items.map((x) => ({ id: x.i.id, refundId: x.i.refundId, number: x.number, customer: x.customer, amount: x.i.amount, state: x.i.state, bank: x.i.beneficiary.bank, account: x.i.beneficiary.account })),
      attachments,
      can: {
        download: f.status === 'generated' && (await canPermission('refund_files:download')),
        confirm: f.status === 'generated' && f.createdBy !== userId && (await canPermission('refund_files:confirm')),
        cancel: f.status === 'generated' && (await canPermission('refund_files:cancel')),
        attach: f.status !== 'cancelled' && (await canPermission('refund_files:upload_evidence')),
      },
    };
  });
}
