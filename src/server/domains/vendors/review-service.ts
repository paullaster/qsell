import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { reasonCodes, vendorBankAccounts, vendorDocuments, vendorDocumentTypes, vendorEvents, vendorProfileVersions, vendors } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { isSection, sectionLabel, type Section } from '@/lib/vendor-profile';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorService, VendorTx } from './service';
import type { VendorNotifier } from './notifier';

/** Reasons a vendor application can be refused for; a company adds its own under the same use. */
const REJECTION_REASONS = [
  { code: 'VENDOR_INCOMPLETE', description: 'The profile or documents are not complete enough to assess', requiresComment: false },
  { code: 'VENDOR_NOT_ELIGIBLE', description: 'The business is not one we can buy from', requiresComment: true },
  { code: 'VENDOR_FAILED_CHECKS', description: 'The business failed our verification checks', requiresComment: true },
  { code: 'VENDOR_DUPLICATE', description: 'We already have this business as a vendor', requiresComment: false },
] as const;

export const VENDOR_REJECTION = 'vendor_rejection';

/**
 * What staff do with a submitted vendor profile (design doc §6.3): take it for review, check each document, then approve it,
 * send it back with a note on each section that needs work, or refuse it with a reason. Every decision is written to the vendor's
 * history with who, why and from where.
 */
export class VendorReviewService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly vendorsService: VendorService,
    private readonly reasons: ReasonCodes,
    private readonly notify?: VendorNotifier,
  ) {}

  /** Makes the standard refusal reasons exist (once); called before they are offered or used. */
  async ensureRejectionReasons(companyId: string): Promise<void> {
    await this.db
      .insert(reasonCodes)
      .values(REJECTION_REASONS.map((r) => ({ companyId, code: r.code, description: r.description, requiresComment: r.requiresComment, appliesTo: [VENDOR_REJECTION], isSystem: true })))
      .onConflictDoNothing({ target: [reasonCodes.companyId, reasonCodes.code] });
  }

  private async event(tx: VendorTx | DrizzleDb, ctx: FinanceContext, vendorId: string, event: string, from: string | null, to: string | null, extra: { reasonCode?: string | null; reasonText?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(vendorEvents).values({ vendorId, event, fromStatus: from, toStatus: to, reasonCode: extra.reasonCode ?? null, reasonText: extra.reasonText ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id, origin: { ...ctx.origin } });
  }

  private async lockVendor(tx: VendorTx, ctx: FinanceContext, vendorId: string) {
    const [v] = await tx.select().from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId))).for('update');
    if (v === undefined) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    return v;
  }

  private async pendingVersion(tx: VendorTx, vendorId: string) {
    const [version] = await tx.select().from(vendorProfileVersions).where(and(eq(vendorProfileVersions.vendorId, vendorId), eq(vendorProfileVersions.decision, 'pending'))).orderBy(desc(vendorProfileVersions.version)).limit(1);
    if (version === undefined) throw new FinanceError('NOTHING_TO_REVIEW', 'There is no submitted profile waiting for a decision.');
    return version;
  }

  /** The reviewer takes a submitted profile; others see who has it. */
  async startReview(ctx: FinanceContext, vendorId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const v = await this.lockVendor(tx, ctx, vendorId);
      if (v.status !== 'profile_submitted') throw new FinanceError('NOT_SUBMITTED', v.status === 'under_review' ? 'This profile is already being reviewed.' : 'This vendor has not sent a profile for review.');
      await tx.update(vendors).set({ status: 'under_review', reviewerId: ctx.actor.id, updatedAt: new Date() }).where(eq(vendors.id, vendorId));
      await this.event(tx, ctx, vendorId, 'review_started', 'profile_submitted', 'under_review');
    });
  }

  /** Marks one uploaded document valid, or not valid with the reason the vendor needs to fix it. */
  async verifyDocument(ctx: FinanceContext, documentId: string, verdict: 'valid' | 'invalid', note: string): Promise<void> {
    const text = trimToNull(note);
    if (verdict === 'invalid' && !has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say what is wrong with the document, so the vendor can replace it.');
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ doc: vendorDocuments, companyId: vendors.companyId })
        .from(vendorDocuments)
        .innerJoin(vendors, eq(vendors.id, vendorDocuments.vendorId))
        .where(eq(vendorDocuments.id, documentId))
        .for('update', { of: vendorDocuments });
      if (row?.companyId !== ctx.companyId) throw new FinanceError('NOT_FOUND', 'That document does not exist.');
      if (row.doc.status === 'replaced') throw new FinanceError('NOT_CURRENT', 'The vendor has uploaded a newer document in its place.');
      if (row.doc.status === 'expired') throw new FinanceError('EXPIRED', 'That document has expired. The vendor must upload a current one.');
      await tx.update(vendorDocuments).set({ status: verdict, verifiedBy: ctx.actor.id, verifiedAt: new Date(), note: text }).where(eq(vendorDocuments.id, documentId));
      await this.event(tx, ctx, row.doc.vendorId, verdict === 'valid' ? 'document_verified' : 'document_rejected', null, null, { reasonText: text, data: { documentId } });
    });
  }

  /** Makes the vendor active: every required document must be verified, the vendor gets its number, and its bank accounts go live. */
  async approve(ctx: FinanceContext, vendorId: string): Promise<{ number: string }> {
    const done = await this.db.transaction(async (tx) => {
      const v = await this.lockVendor(tx, ctx, vendorId);
      if (v.status !== 'profile_submitted' && v.status !== 'under_review') throw new FinanceError('NOT_SUBMITTED', 'This vendor has not sent a profile for review.');
      const version = await this.pendingVersion(tx, vendorId);
      const required = await tx.select({ id: vendorDocumentTypes.id, name: vendorDocumentTypes.name }).from(vendorDocumentTypes).where(and(eq(vendorDocumentTypes.companyId, ctx.companyId), eq(vendorDocumentTypes.requiredForAll, true), eq(vendorDocumentTypes.isActive, true)));
      const held = await tx.select({ typeId: vendorDocuments.documentTypeId, status: vendorDocuments.status }).from(vendorDocuments).where(and(eq(vendorDocuments.vendorId, vendorId), inArray(vendorDocuments.status, ['submitted', 'valid'])));
      for (const type of required) {
        if (!held.some((h) => h.typeId === type.id && h.status === 'valid')) throw new FinanceError('DOCUMENT_NOT_VERIFIED', `Verify the vendor’s ${type.name.toLowerCase()} first.`);
      }
      const number = await this.vendorsService.activateIn(tx, ctx, vendorId, v.status);
      await tx.update(vendorBankAccounts).set({ status: 'active' }).where(and(eq(vendorBankAccounts.vendorId, vendorId), eq(vendorBankAccounts.status, 'draft')));
      await tx.update(vendors).set({ decidedAt: new Date(), reviewerId: ctx.actor.id }).where(eq(vendors.id, vendorId));
      await tx.update(vendorProfileVersions).set({ decision: 'approved', decidedAt: new Date(), decidedBy: ctx.actor.id }).where(eq(vendorProfileVersions.id, version.id));
      return { number };
    });
    await this.notify?.approved(vendorId, done.number);
    return done;
  }

  /** Sends the profile back: at least one section with a note on what to fix; the vendor can change it again. */
  async requestRevision(ctx: FinanceContext, vendorId: string, notes: Record<string, string>, comment: string): Promise<void> {
    const cleaned: Partial<Record<Section, string>> = {};
    for (const [key, value] of Object.entries(notes)) {
      const text = trimToNull(value);
      if (isSection(key) && has(text)) cleaned[key] = text.slice(0, 1000);
    }
    if (Object.keys(cleaned).length === 0) throw new FinanceError('NOTE_REQUIRED', 'Say which section needs work and what to change.');
    await this.db.transaction(async (tx) => {
      const v = await this.lockVendor(tx, ctx, vendorId);
      if (v.status !== 'profile_submitted' && v.status !== 'under_review') throw new FinanceError('NOT_SUBMITTED', 'This vendor has not sent a profile for review.');
      const version = await this.pendingVersion(tx, vendorId);
      await tx.update(vendorProfileVersions).set({ decision: 'revision_requested', decidedAt: new Date(), decidedBy: ctx.actor.id, sectionNotes: cleaned, comment: trimToNull(comment) }).where(eq(vendorProfileVersions.id, version.id));
      await tx.update(vendors).set({ status: 'revision_requested', decidedAt: new Date(), reviewerId: ctx.actor.id, updatedAt: new Date() }).where(eq(vendors.id, vendorId));
      await this.event(tx, ctx, vendorId, 'revision_requested', v.status, 'revision_requested', { reasonText: trimToNull(comment), data: { sections: Object.keys(cleaned).map((k) => sectionLabel(k)) } });
    });
    await this.notify?.revisionRequested(vendorId, cleaned, trimToNull(comment));
  }

  /** Refuses the application with a reason from the list (a comment where the reason asks for one). */
  async reject(ctx: FinanceContext, vendorId: string, reason: { code: string; text?: string | null }): Promise<void> {
    await this.ensureRejectionReasons(ctx.companyId);
    const checked = await this.reasons.require(ctx.companyId, reason, VENDOR_REJECTION);
    await this.db.transaction(async (tx) => {
      const v = await this.lockVendor(tx, ctx, vendorId);
      if (v.status !== 'profile_submitted' && v.status !== 'under_review') throw new FinanceError('NOT_SUBMITTED', 'This vendor has not sent a profile for review.');
      const version = await this.pendingVersion(tx, vendorId);
      await tx.update(vendorProfileVersions).set({ decision: 'rejected', decidedAt: new Date(), decidedBy: ctx.actor.id, reasonCode: checked.code, comment: checked.text }).where(eq(vendorProfileVersions.id, version.id));
      await tx.update(vendors).set({ status: 'rejected', decidedAt: new Date(), reviewerId: ctx.actor.id, updatedAt: new Date() }).where(eq(vendors.id, vendorId));
      await this.event(tx, ctx, vendorId, 'rejected', v.status, 'rejected', { reasonCode: checked.code, reasonText: checked.text });
    });
    await this.notify?.refused(vendorId, checked.text ?? REJECTION_REASONS.find((r) => r.code === checked.code)?.description ?? 'Not accepted');
  }

  /** Vendors waiting for a person: submitted and under review, oldest submission first. */
  async queue(companyId: string) {
    return await this.db
      .select({ id: vendors.id, legalName: vendors.legalName, status: vendors.status, submittedAt: vendors.submittedAt, reviewerId: vendors.reviewerId })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), or(eq(vendors.status, 'profile_submitted'), eq(vendors.status, 'under_review'))))
      .orderBy(vendors.submittedAt)
      .limit(100);
  }
}
