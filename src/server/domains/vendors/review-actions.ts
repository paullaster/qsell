'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { SECTIONS } from '@/lib/vendor-profile';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const text = (value: unknown, max = 1000): string => (typeof value === 'string' ? value.slice(0, max) : '');

/** What a reviewer reads to decide: the vendor's profile section by section, its documents, its bank accounts (masked) and what was decided before. */
export async function vendorReviewAction(vendorId: string) {
  return await run('vendors:read', { surface: 'vendors/review', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const vid = id(vendorId);
    await container.vendorReview.ensureRejectionReasons(ctx.companyId);
    const loaded = await container.vendorProfile.load(ctx.companyId, vid);
    if (loaded === null) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    const state = container.vendorProfile.toState(loaded);
    const [canReview, canApprove, canReject, canRevise, canVerify, canView] = await Promise.all([
      canPermission('vendors:review'),
      canPermission('vendors:approve'),
      canPermission('vendors:reject'),
      canPermission('vendors:request_revision'),
      canPermission('vendors:verify_documents'),
      canPermission('vendors:view_documents'),
    ]);
    const v = loaded.vendor;
    return {
      status: v.status,
      submittedAt: v.submittedAt?.toISOString() ?? null,
      profile: state.profile,
      business: state.business,
      financial: state.financial,
      contacts: state.contacts,
      directors: loaded.directors.map((d) => ({ id: d.id, name: d.name, idType: d.idType, idLast4: d.idLast4, share: d.sharePercent })),
      references: state.references,
      banks: loaded.banks.map((b) => ({ id: b.id, bankName: b.bankName, branch: b.branch, accountName: b.accountName, last4: b.accountLast4, status: b.status })),
      documents: loaded.types
        .filter((t) => t.isActive)
        .map((t) => {
          const d = loaded.documents.find((x) => x.doc.documentTypeId === t.id);
          return {
            typeName: t.name,
            required: t.requiredForAll,
            doc: d === undefined ? null : { id: d.doc.id, fileId: d.doc.fileId, fileName: d.fileName, status: d.doc.status, expiresOn: d.doc.expiresOn, issuedOn: d.doc.issuedOn, note: d.doc.note, uploadedAt: d.doc.createdAt.toISOString() },
          };
        }),
      versions: loaded.versions.map((x) => ({ version: x.version, submittedAt: x.submittedAt.toISOString(), decision: x.decision, decidedAt: x.decidedAt?.toISOString() ?? null, reasonCode: x.reasonCode, comment: x.comment, sectionNotes: x.sectionNotes })),
      sections: SECTIONS.map((s) => ({ id: s.id, label: s.label })),
      can: { review: canReview, approve: canApprove, reject: canReject, requestRevision: canRevise, verify: canVerify, viewDocuments: canView },
    };
  });
}

export async function startReviewAction(vendorId: string) {
  return await run('vendors:review', { surface: 'vendors/review', action: 'start' }, async (ctx) => {
    await getContainer().vendorReview.startReview(ctx, id(vendorId));
  }, ['/admin/vendors']);
}

export async function verifyDocumentAction(documentId: string, verdict: string, note: string) {
  return await run('vendors:verify_documents', { surface: 'vendors/review', action: 'verify_document' }, async (ctx) => {
    if (verdict !== 'valid' && verdict !== 'invalid') throw new FinanceError('INVALID', 'Choose valid or not valid.');
    await getContainer().vendorReview.verifyDocument(ctx, id(documentId), verdict, text(note, 500));
  });
}

export async function approveVendorAction(vendorId: string) {
  return await run('vendors:approve', { surface: 'vendors/review', action: 'approve' }, async (ctx) => {
    return await getContainer().vendorReview.approve(ctx, id(vendorId));
  }, ['/admin/vendors']);
}

export async function requestRevisionAction(vendorId: string, notes: unknown, comment: string) {
  return await run('vendors:request_revision', { surface: 'vendors/review', action: 'request_revision' }, async (ctx) => {
    const raw = typeof notes === 'object' && notes !== null ? (notes as Record<string, unknown>) : {};
    const cleaned = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, text(v)]));
    await getContainer().vendorReview.requestRevision(ctx, id(vendorId), cleaned, text(comment, 500));
  }, ['/admin/vendors']);
}

export async function rejectVendorAction(vendorId: string, reason: { code: string; text?: string }) {
  return await run('vendors:reject', { surface: 'vendors/review', action: 'reject' }, async (ctx) => {
    await getContainer().vendorReview.reject(ctx, id(vendorId), { code: text(reason.code, 60), text: text(reason.text, 500) });
  }, ['/admin/vendors']);
}
