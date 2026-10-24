'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { emptyDocumentType, type DocumentTypeForm } from '@/lib/vendor-document-types';
import { ProfileError } from './profile-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const text = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const reasonOf = (r: unknown): { code: string; text: string } => {
  const raw = typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {};
  return { code: text(raw.code, 60), text: text(raw.text) };
};
/** A rule the person can fix is shown as written, like any other refusal. */
async function plain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProfileError) throw new FinanceError(error.code, error.message, undefined);
    throw error;
  }
}

// ── Standing: suspend, block, archive ─────────────────────────────────────────────────────────

export async function suspendVendorAction(vendorId: string, reason: unknown) {
  return await run('vendors:suspend', { surface: 'vendors/standing', action: 'suspend' }, async (ctx) => {
    await getContainer().vendorLifecycle.suspend(ctx, id(vendorId), reasonOf(reason));
  }, ['/admin/vendors']);
}

export async function reinstateVendorAction(vendorId: string) {
  return await run('vendors:suspend', { surface: 'vendors/standing', action: 'reinstate' }, async (ctx) => {
    await getContainer().vendorLifecycle.reinstate(ctx, id(vendorId));
  }, ['/admin/vendors']);
}

export async function blockVendorAction(vendorId: string, block: string, reason: unknown) {
  return await run('vendors:block', { surface: 'vendors/standing', action: 'block' }, async (ctx) => {
    if (block !== 'none' && block !== 'payment' && block !== 'all') throw new FinanceError('INVALID', 'Choose what to block.');
    await getContainer().vendorLifecycle.setBlock(ctx, id(vendorId), block, reasonOf(reason));
  }, ['/admin/vendors']);
}

export async function archiveVendorAction(vendorId: string, reason: unknown) {
  return await run('vendors:archive', { surface: 'vendors/standing', action: 'archive' }, async (ctx) => {
    await getContainer().vendorLifecycle.archive(ctx, id(vendorId), reasonOf(reason));
  }, ['/admin/vendors']);
}

export async function restoreVendorAction(vendorId: string) {
  return await run('vendors:archive', { surface: 'vendors/standing', action: 'restore' }, async (ctx) => {
    await getContainer().vendorLifecycle.restore(ctx, id(vendorId));
  }, ['/admin/vendors']);
}

// ── Invitations ───────────────────────────────────────────────────────────────────────────────

export async function inviteVendorOwnerAction(vendorId: string, who: { email: string; name: string }) {
  return await run('vendors:invite', { surface: 'vendors/invite', action: 'invite_owner' }, async (ctx) => {
    await getContainer().vendorInvitations.inviteOwner(ctx, id(vendorId), { email: text(who.email, 200), name: text(who.name, 200) });
  }, ['/admin/vendors']);
}

export async function resendVendorInvitationAction(vendorId: string, vendorUserId: string) {
  return await run('vendors:invite', { surface: 'vendors/invite', action: 'resend' }, async (ctx) => {
    const vid = id(vendorId);
    const container = getContainer();
    const found = await container.vendors.get(ctx.companyId, vid);
    if (found === null) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    await container.vendorInvitations.resend(vid, id(vendorUserId));
  });
}

export async function cancelVendorInvitationAction(vendorId: string, vendorUserId: string) {
  return await run('vendors:invite', { surface: 'vendors/invite', action: 'cancel' }, async (ctx) => {
    const vid = id(vendorId);
    const container = getContainer();
    const found = await container.vendors.get(ctx.companyId, vid);
    if (found === null) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    await container.vendorInvitations.remove(vid, id(vendorUserId), { type: 'user', id: ctx.actor.id ?? '' }, { ...ctx.origin });
  }, ['/admin/vendors']);
}

// ── Worklists ─────────────────────────────────────────────────────────────────────────────────

/** Vendors waiting for a person, oldest first. */
export async function reviewQueueAction() {
  return await run('vendors:read', { surface: 'vendors/review-queue', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const [rows, canReview] = await Promise.all([container.vendorReview.queue(ctx.companyId), canPermission('vendors:review')]);
    return { rows: rows.map((r) => ({ id: r.id, legalName: r.legalName, status: r.status, submittedAt: r.submittedAt?.toISOString() ?? null, reviewerId: r.reviewerId })), canReview };
  });
}

export async function expiringDocumentsAction(filter: { withinDays?: number; before?: { expiresOn: string; id: string } | null } = {}) {
  return await run('vendors:read', { surface: 'vendors/expiring', action: 'view' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && /^\d{4}-\d{2}-\d{2}$/.test(filter.before.expiresOn) ? filter.before : null;
    const within = typeof filter.withinDays === 'number' && Number.isFinite(filter.withinDays) ? Math.trunc(filter.withinDays) : 60;
    return await getContainer().vendorExpiry.expiring(ctx.companyId, { withinDays: within, before }, businessDate());
  });
}

// ── Bank-detail changes (staff side) ──────────────────────────────────────────────────────────

export async function bankChangesAction() {
  return await run('vendors:read', { surface: 'vendors/bank-changes', action: 'view' }, async (ctx) => {
    const [rows, canCall, canApprove, canOpen] = await Promise.all([
      getContainer().vendorBank.worklist(ctx.companyId),
      canPermission('vendor_bank:verify_callback'),
      canPermission('vendor_bank:approve_change'),
      canPermission('vendors:view_documents'),
    ]);
    return { rows, me: ctx.actor.id, can: { callback: canCall, approve: canApprove, viewDocuments: canOpen } };
  });
}

export async function recordBankCallbackAction(changeId: string, note: string) {
  return await run('vendor_bank:verify_callback', { surface: 'vendors/bank-changes', action: 'callback' }, async (ctx) => {
    await getContainer().vendorBank.recordCallback(ctx, id(changeId), text(note, 1000));
  }, ['/admin/vendors/bank-changes']);
}

export async function approveBankChangeAction(changeId: string) {
  return await run('vendor_bank:approve_change', { surface: 'vendors/bank-changes', action: 'approve' }, async (ctx) => {
    const done = await getContainer().vendorBank.approve(ctx, id(changeId));
    return { effectiveFrom: done.effectiveFrom.toISOString() };
  }, ['/admin/vendors/bank-changes']);
}

export async function rejectBankChangeAction(changeId: string, note: string) {
  return await run('vendor_bank:approve_change', { surface: 'vendors/bank-changes', action: 'reject' }, async (ctx) => {
    await getContainer().vendorBank.reject(ctx, id(changeId), text(note));
  }, ['/admin/vendors/bank-changes']);
}

// ── Document types ────────────────────────────────────────────────────────────────────────────

export async function documentTypesAction() {
  return await run('vendor_settings:manage', { surface: 'vendors/document-types', action: 'view' }, async (ctx) => {
    // The standard set is made the first time anyone looks.
    return (await getContainer().vendorProfile.documentTypes(ctx.companyId)).map(shape);
  });
}

const shape = (t: { id: string; code: string; name: string; requiredForAll: boolean; needsExpiry: boolean; reminderDays: number[]; blocking: boolean; isActive: boolean }) => ({
  id: t.id,
  code: t.code,
  name: t.name,
  requiredForAll: t.requiredForAll,
  needsExpiry: t.needsExpiry,
  reminderDays: t.reminderDays.join(', '),
  blocking: t.blocking,
  isActive: t.isActive,
});

export async function saveDocumentTypeAction(typeId: string | null, form: unknown) {
  return await run('vendor_settings:manage', { surface: 'vendors/document-types', action: typeId === null ? 'create' : 'update' }, async (ctx) => {
    const raw = typeof form === 'object' && form !== null ? (form as Record<string, unknown>) : {};
    const base = emptyDocumentType();
    const clean: DocumentTypeForm = {
      code: text(raw.code, 40),
      name: text(raw.name, 120),
      requiredForAll: raw.requiredForAll === true,
      needsExpiry: raw.needsExpiry === true,
      reminderDays: typeof raw.reminderDays === 'string' ? raw.reminderDays.slice(0, 60) : base.reminderDays,
      blocking: raw.blocking === true,
      isActive: raw.isActive !== false,
    };
    return await plain(() => getContainer().vendorDocumentTypes.save(ctx.companyId, typeId === null ? null : id(typeId), clean));
  }, ['/admin/vendors/document-types']);
}
