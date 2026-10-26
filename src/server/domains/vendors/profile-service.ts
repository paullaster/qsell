import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  vendorBankAccounts,
  vendorContacts,
  vendorDirectors,
  vendorDocumentTypes,
  vendorDocuments,
  vendorEvents,
  vendorFiles,
  vendorProfileVersions,
  vendorReferences,
  vendors,
  type VendorRow,
} from '@/server/db/drizzle/schema';
import { has } from '@/lib/values';
import { decryptCredentials, encryptCredentials, fingerprintSecret } from '@/server/domains/payments/crypto';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { normaliseTaxId } from '@/lib/vendor-forms';
import {
  allStatuses,
  checkBanks,
  checkBusiness,
  checkContacts,
  checkDirectors,
  checkFinancial,
  checkProfile,
  checkReferences,
  mayEditProfileNow,
  missingIn,
  profileComplete,
  type BankInput,
  kindOf,
  mpesaWord,
  numberOf,
  type BusinessData,
  type ContactInput,
  type DirectorInput,
  type FinancialData,
  type ProfileData,
  type ProfileState,
  type ReferenceInput,
  type Section,
  type SectionStatus,
} from '@/lib/vendor-profile';
import { FileRejected, type VendorFileStore } from './file-store';
import type { VendorNotifier } from './notifier';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** A refusal that is the person's to fix: the message is shown as written. */
export class ProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly problems: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

export interface PortalActor {
  vendorId: string;
  userId: string;
  portalRole: string;
}

const DEFAULT_DOCUMENT_TYPES = [
  { code: 'INCORPORATION', name: 'Certificate of incorporation or registration', requiredForAll: true, needsExpiry: false, blocking: false },
  { code: 'TAX_COMPLIANCE', name: 'Tax compliance certificate', requiredForAll: true, needsExpiry: true, blocking: true },
  { code: 'TAX_PIN', name: 'Tax PIN certificate', requiredForAll: true, needsExpiry: false, blocking: false },
  { code: 'BANK_LETTER', name: 'Bank confirmation letter', requiredForAll: true, needsExpiry: false, blocking: false },
  { code: 'BUSINESS_PERMIT', name: 'Business permit', requiredForAll: false, needsExpiry: true, blocking: false },
  { code: 'DIRECTOR_ID', name: 'Directors’ ID copies', requiredForAll: false, needsExpiry: false, blocking: false },
  { code: 'COMPANY_PROFILE', name: 'Company profile', requiredForAll: false, needsExpiry: false, blocking: false },
  { code: 'INSURANCE', name: 'Insurance certificate', requiredForAll: false, needsExpiry: true, blocking: false },
] as const;

const t = (v: string): string | null => (has(v) ? v.trim() : null);
const n = (v: string): number | null => (has(v) ? Number(v.trim()) : null);

/**
 * The vendor's own profile (design doc §6): five sections saved a piece at a time, documents with expiry dates, and one
 * submission that freezes a copy for the reviewer. Every method takes the vendor from the caller's session, never from input.
 */
export class VendorProfileService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly files: VendorFileStore,
    private readonly notify?: VendorNotifier,
  ) {}

  /** The document types a company asks for; the standard set is made the first time they are needed. */
  async documentTypes(companyId: string) {
    const existing = await this.db.select().from(vendorDocumentTypes).where(eq(vendorDocumentTypes.companyId, companyId)).orderBy(asc(vendorDocumentTypes.sortOrder), asc(vendorDocumentTypes.name));
    if (existing.length > 0) return existing;
    await this.db
      .insert(vendorDocumentTypes)
      .values(DEFAULT_DOCUMENT_TYPES.map((d, i) => ({ companyId, ...d, sortOrder: i })))
      .onConflictDoNothing({ target: [vendorDocumentTypes.companyId, vendorDocumentTypes.code] });
    return await this.db.select().from(vendorDocumentTypes).where(eq(vendorDocumentTypes.companyId, companyId)).orderBy(asc(vendorDocumentTypes.sortOrder), asc(vendorDocumentTypes.name));
  }

  /** Everything about a vendor's profile that the rules need, read in parallel. */
  async load(companyId: string, vendorId: string) {
    const types = await this.documentTypes(companyId);
    const [[vendor], contacts, directors, references, banks, documents, versions] = await Promise.all([
      this.db.select().from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, vendorId))),
      this.db.select().from(vendorContacts).where(eq(vendorContacts.vendorId, vendorId)).orderBy(desc(vendorContacts.isPrimary), asc(vendorContacts.createdAt)),
      this.db.select().from(vendorDirectors).where(eq(vendorDirectors.vendorId, vendorId)).orderBy(asc(vendorDirectors.createdAt)),
      this.db.select().from(vendorReferences).where(eq(vendorReferences.vendorId, vendorId)).orderBy(asc(vendorReferences.createdAt)),
      this.db.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, vendorId), ne(vendorBankAccounts.status, 'retired'))).orderBy(asc(vendorBankAccounts.createdAt)),
      this.db
        .select({ doc: vendorDocuments, fileName: vendorFiles.fileName, mime: vendorFiles.mime, size: vendorFiles.sizeBytes })
        .from(vendorDocuments)
        .innerJoin(vendorFiles, eq(vendorFiles.id, vendorDocuments.fileId))
        .where(eq(vendorDocuments.vendorId, vendorId))
        .orderBy(desc(vendorDocuments.createdAt)),
      this.db.select().from(vendorProfileVersions).where(eq(vendorProfileVersions.vendorId, vendorId)).orderBy(desc(vendorProfileVersions.version)),
    ]);
    if (vendor === undefined) return null;
    const live = documents.filter((d) => d.doc.status !== 'replaced');
    return { vendor, types, contacts, directors, references, banks, documents: live, history: documents.filter((d) => d.doc.status === 'replaced'), versions };
  }

  /** The vendor's facts as the pure rules want them. */
  toState(loaded: NonNullable<Awaited<ReturnType<VendorProfileService['load']>>>, taxPattern: RegExp | null = null): ProfileState {
    const v = loaded.vendor;
    const currentFor = (typeId: string) => loaded.documents.find((d) => d.doc.documentTypeId === typeId && d.doc.status !== 'invalid' && d.doc.status !== 'expired');
    return {
      profile: {
        vendorType: v.vendorType,
        tradingName: v.tradingName ?? '',
        country: v.country ?? '',
        description: v.description ?? '',
        yearEstablished: v.yearEstablished === null ? '' : String(v.yearEstablished),
        website: v.website ?? '',
        physicalStreet: v.physicalStreet ?? '',
        physicalCity: v.physicalCity ?? '',
        physicalCounty: v.physicalCounty ?? '',
        physicalPostalCode: v.physicalPostalCode ?? '',
        postalAddress: v.postalAddress ?? '',
        phone: v.phone ?? '',
      },
      business: {
        registrationNo: v.registrationNo ?? '',
        registrationDate: v.registrationDate ?? '',
        taxId: v.taxId ?? '',
        vatNo: v.vatNo ?? '',
        employeeCount: v.employeeCount === null ? '' : String(v.employeeCount),
        taxExempt: v.taxExempt,
      },
      financial: {
        offeredPaymentTermDays: v.offeredPaymentTermDays === null ? '' : String(v.offeredPaymentTermDays),
        turnoverBand: v.turnoverBand ?? '',
        mobileMoneyNumber: v.mobileMoneyNumber ?? '',
      },
      contacts: loaded.contacts.map((c) => ({ name: c.name, role: c.role, email: c.email, phone: c.phone, isPrimary: c.isPrimary })),
      directors: loaded.directors.map((d) => ({ name: d.name, idType: d.idType, sharePercent: d.sharePercent ?? '' })),
      references: loaded.references.map((r) => ({ clientName: r.clientName, workDescription: r.workDescription ?? '', valueAmount: r.valueAmount ?? '', contactName: r.contactName ?? '', contactPhone: r.contactPhone ?? '', year: r.year === null ? '' : String(r.year) })),
      banks: loaded.banks.length,
      requiredDocuments: loaded.types
        .filter((d) => d.isActive && d.requiredForAll)
        .map((d) => {
          const doc = currentFor(d.id);
          return { code: d.code, name: d.name.toLowerCase(), held: doc !== undefined, needsExpiry: d.needsExpiry, hasExpiry: doc?.doc.expiresOn != null };
        }),
      taxPattern,
    };
  }

  async statuses(companyId: string, vendorId: string): Promise<{ vendor: VendorRow; statuses: Record<Section, SectionStatus>; missing: Record<Section, string[]>; complete: boolean } | null> {
    const loaded = await this.load(companyId, vendorId);
    if (loaded === null) return null;
    const state = this.toState(loaded);
    const sections: Section[] = ['profile', 'business', 'financial', 'contacts', 'attachments'];
    return {
      vendor: loaded.vendor,
      statuses: allStatuses(state),
      missing: Object.fromEntries(sections.map((s) => [s, missingIn(s, state)])) as Record<Section, string[]>,
      complete: profileComplete(state),
    };
  }

  private async event(tx: Tx | DrizzleDb, vendorId: string, event: string, actor: PortalActor, data: Record<string, unknown> = {}, from: string | null = null, to: string | null = null): Promise<void> {
    await tx.insert(vendorEvents).values({ vendorId, event, fromStatus: from, toStatus: to, data, actorType: 'user', actorId: actor.userId, origin: { surface: 'vendor/portal', action: event, portalRole: actor.portalRole } });
  }

  /** The vendor may change this section now, by its status and by the role of the person asking. */
  private async guard(tx: Tx | DrizzleDb, actor: PortalActor, section: Section, lock = true): Promise<VendorRow> {
    const query = tx.select().from(vendors).where(eq(vendors.id, actor.vendorId));
    const [v] = await (lock ? query.for('update') : query);
    if (v === undefined) throw new ProfileError('NOT_FOUND', 'Your vendor account could not be found.');
    const verdict = mayEditProfileNow(v.status, v.decidedAt, new Date(), actor.portalRole, section);
    if (verdict !== 'yes') throw new ProfileError('NOT_EDITABLE', verdict);
    return v;
  }

  /** Saving anything for the first time moves a freshly registered vendor to "completing profile". */
  private async started(tx: Tx, v: VendorRow, actor: PortalActor): Promise<void> {
    if (v.status === 'registered' || v.status === 'rejected') {
      await tx.update(vendors).set({ status: 'profile_in_progress', updatedAt: new Date() }).where(eq(vendors.id, v.id));
      await this.event(tx, v.id, 'profile_started', actor, {}, v.status, 'profile_in_progress');
    } else {
      await tx.update(vendors).set({ updatedAt: new Date() }).where(eq(vendors.id, v.id));
    }
  }

  async saveProfile(actor: PortalActor, d: ProfileData): Promise<void> {
    const problems = checkProfile(d);
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the form.', problems);
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'profile');
      await tx
        .update(vendors)
        .set({
          vendorType: d.vendorType,
          tradingName: t(d.tradingName),
          country: d.country.trim(),
          description: d.description.trim(),
          yearEstablished: n(d.yearEstablished),
          website: t(d.website),
          physicalStreet: d.physicalStreet.trim(),
          physicalCity: d.physicalCity.trim(),
          physicalCounty: t(d.physicalCounty),
          physicalPostalCode: t(d.physicalPostalCode),
          postalAddress: t(d.postalAddress),
          phone: d.phone.trim(),
        })
        .where(eq(vendors.id, v.id));
      await this.started(tx, v, actor);
      await this.event(tx, v.id, 'section_saved', actor, { section: 'profile' });
    });
  }

  async saveBusiness(actor: PortalActor, d: BusinessData, taxPattern: RegExp | null = null): Promise<void> {
    const problems = checkBusiness(d, taxPattern);
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the form.', problems);
    try {
      await this.db.transaction(async (tx) => {
        const v = await this.guard(tx, actor, 'business');
        await tx
          .update(vendors)
          .set({ registrationNo: d.registrationNo.trim(), registrationDate: d.registrationDate.trim(), taxId: normaliseTaxId(d.taxId), vatNo: t(d.vatNo), employeeCount: n(d.employeeCount), taxExempt: d.taxExempt })
          .where(eq(vendors.id, v.id));
        await this.started(tx, v, actor);
        await this.event(tx, v.id, 'section_saved', actor, { section: 'business' });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProfileError('TAX_ID_TAKEN', 'That tax ID is already registered with us. If it is your business, contact the buyer.', { taxId: 'That tax ID is already registered with us.' });
      throw error;
    }
  }

  async addDirector(actor: PortalActor, d: DirectorInput): Promise<void> {
    const problems = checkDirectors([d]);
    const own = Object.fromEntries(Object.entries(problems).filter(([k]) => k.startsWith('directors.0.')));
    if (Object.keys(own).length > 0) throw new ProfileError('INVALID', Object.values(own)[0] ?? 'Check the form.', own);
    const id = d.idNumber.replace(/\s+/g, '');
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'business');
      const current = await tx.select({ share: vendorDirectors.sharePercent }).from(vendorDirectors).where(eq(vendorDirectors.vendorId, v.id));
      if (current.length >= 30) throw new ProfileError('TOO_MANY', 'That is more directors than we can keep (30 at most).');
      const total = current.reduce((sum, r) => sum + Number(r.share ?? 0), 0) + (has(d.sharePercent) ? Number(d.sharePercent) : 0);
      if (total > 100.0001) throw new ProfileError('INVALID', 'The shares add up to more than 100%.');
      await tx.insert(vendorDirectors).values({ vendorId: v.id, name: d.name.trim(), idType: d.idType, idNumberSealed: encryptCredentials({ id }), idLast4: id.slice(-4), sharePercent: has(d.sharePercent) ? d.sharePercent.trim() : null });
      await this.started(tx, v, actor);
      await this.event(tx, v.id, 'director_added', actor);
    });
  }

  async removeDirector(actor: PortalActor, directorId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'business');
      await tx.delete(vendorDirectors).where(and(eq(vendorDirectors.id, directorId), eq(vendorDirectors.vendorId, v.id)));
      await this.event(tx, v.id, 'director_removed', actor);
    });
  }

  async saveReferences(actor: PortalActor, list: ReferenceInput[]): Promise<void> {
    const problems = checkReferences(list);
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the form.', problems);
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'business');
      await tx.delete(vendorReferences).where(eq(vendorReferences.vendorId, v.id));
      if (list.length > 0) {
        await tx.insert(vendorReferences).values(
          list.map((r) => ({ vendorId: v.id, clientName: r.clientName.trim(), workDescription: t(r.workDescription), valueAmount: t(r.valueAmount), contactName: t(r.contactName), contactPhone: t(r.contactPhone), year: n(r.year) })),
        );
      }
      await this.started(tx, v, actor);
      await this.event(tx, v.id, 'references_saved', actor, { count: list.length });
    });
  }

  async saveFinancial(actor: PortalActor, d: FinancialData): Promise<void> {
    const problems = checkFinancial(d);
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the form.', problems);
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'financial');
      await tx.update(vendors).set({ offeredPaymentTermDays: n(d.offeredPaymentTermDays), turnoverBand: t(d.turnoverBand), mobileMoneyNumber: t(d.mobileMoneyNumber) }).where(eq(vendors.id, v.id));
      await this.started(tx, v, actor);
      await this.event(tx, v.id, 'section_saved', actor, { section: 'financial' });
    });
  }

  /**
   * Adds a bank account while the profile is still being written. After the vendor is approved a change goes through
   * the controlled change flow (V-1b), never through here: the guard allows `financial` only before approval.
   */
  async addBank(actor: PortalActor, b: BankInput): Promise<void> {
    const problems = checkBanks([b]);
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the form.', problems);
    const number = numberOf(b);
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'financial');
      const existing = await tx.select({ id: vendorBankAccounts.id }).from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, v.id), ne(vendorBankAccounts.status, 'retired')));
      if (existing.length >= 5) throw new ProfileError('TOO_MANY', 'That is more bank accounts than we can keep (5 at most).');
      const kind = kindOf(b);
      await tx.insert(vendorBankAccounts).values({
        vendorId: v.id,
        kind,
        reference: kind === 'bank' ? null : (t(b.reference ?? '') ?? null),
        bankName: kind === 'bank' ? b.bankName.trim() : 'M-Pesa',
        branch: kind === 'bank' ? b.branch.trim() : mpesaWord(kind),
        accountName: b.accountName.trim(),
        accountSealed: encryptCredentials({ number }),
        accountLast4: number.slice(-4),
        accountHash: fingerprintSecret(number),
        swift: kind === 'bank' ? (t(b.swift)?.toUpperCase() ?? null) : null,
        status: 'draft',
        createdBy: actor.userId,
      });
      await this.started(tx, v, actor);
      await this.event(tx, v.id, 'bank_account_added', actor);
    });
  }

  async removeBank(actor: PortalActor, bankId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'financial');
      await tx.delete(vendorBankAccounts).where(and(eq(vendorBankAccounts.id, bankId), eq(vendorBankAccounts.vendorId, v.id), eq(vendorBankAccounts.status, 'draft')));
      await this.event(tx, v.id, 'bank_account_removed', actor);
    });
  }

  async saveContacts(actor: PortalActor, list: ContactInput[]): Promise<void> {
    const problems = checkContacts(list);
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the form.', problems);
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'contacts');
      await tx.delete(vendorContacts).where(eq(vendorContacts.vendorId, v.id));
      await tx.insert(vendorContacts).values(list.map((c) => ({ vendorId: v.id, name: c.name.trim(), role: c.role as 'management', email: c.email.trim().toLowerCase(), phone: c.phone.trim(), isPrimary: c.isPrimary })));
      await this.started(tx, v, actor);
      await this.event(tx, v.id, 'section_saved', actor, { section: 'contacts' });
    });
  }

  /** Attaches an uploaded file to a document type; a newer one for the same type replaces the older (which is kept). */
  async addDocument(actor: PortalActor, companyId: string, input: { documentTypeId: string; originalName: string; data: Buffer; issuedOn: string; expiresOn: string }): Promise<{ id: string }> {
    const types = await this.documentTypes(companyId);
    const type = types.find((x) => x.id === input.documentTypeId && x.isActive);
    if (type === undefined) throw new ProfileError('INVALID', 'Choose which document this is.');
    const issued = has(input.issuedOn) ? input.issuedOn.trim() : null;
    const expires = has(input.expiresOn) ? input.expiresOn.trim() : null;
    const dateOk = (d: string | null) => d === null || /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!dateOk(issued) || !dateOk(expires)) throw new ProfileError('INVALID', 'Enter dates as year-month-day.');
    if (type.needsExpiry && expires === null) throw new ProfileError('INVALID', `Enter the expiry date of your ${type.name.toLowerCase()}.`, { expiresOn: 'Required for this document.' });
    if (expires !== null && expires < new Date().toISOString().slice(0, 10)) throw new ProfileError('INVALID', 'That document has already expired. Upload a current one.', { expiresOn: 'Already expired.' });
    if (issued !== null && expires !== null && expires < issued) throw new ProfileError('INVALID', 'The expiry date is before the date it was issued.');
    // Checked before the file is stored, so a file nobody may attach is never kept.
    await this.guard(this.db, actor, 'attachments', false);
    let stored;
    try {
      stored = await this.files.put({ companyId, vendorId: actor.vendorId, originalName: input.originalName, data: input.data, createdBy: actor.userId });
    } catch (error) {
      if (error instanceof FileRejected) throw new ProfileError('FILE_REJECTED', error.message);
      throw error;
    }
    return await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'attachments');
      await tx.update(vendorDocuments).set({ status: 'replaced' }).where(and(eq(vendorDocuments.vendorId, v.id), eq(vendorDocuments.documentTypeId, type.id), inArray(vendorDocuments.status, ['submitted', 'valid', 'invalid', 'expired'])));
      const [doc] = await tx.insert(vendorDocuments).values({ vendorId: v.id, documentTypeId: type.id, fileId: stored.id, issuedOn: issued, expiresOn: expires, status: 'submitted', createdBy: actor.userId }).returning({ id: vendorDocuments.id });
      if (doc === undefined) throw new ProfileError('FILE_REJECTED', 'The document could not be saved.');
      await this.started(tx, v, actor);
      await this.event(tx, v.id, 'document_uploaded', actor, { type: type.code, fileName: stored.fileName });
      return { id: doc.id };
    });
  }

  async removeDocument(actor: PortalActor, documentId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'attachments');
      const [doc] = await tx.select().from(vendorDocuments).where(and(eq(vendorDocuments.id, documentId), eq(vendorDocuments.vendorId, v.id)));
      if (doc === undefined) throw new ProfileError('NOT_FOUND', 'That document does not exist.');
      if (doc.status === 'valid') throw new ProfileError('NOT_ALLOWED', 'A document we have verified cannot be removed. Upload a newer one to replace it.');
      await tx.update(vendorDocuments).set({ status: 'replaced' }).where(eq(vendorDocuments.id, doc.id));
      await this.event(tx, v.id, 'document_removed', actor);
    });
  }

  /** Sends the profile for review: the owner only, only when every section is complete, and the copy sent is frozen. */
  async submit(actor: PortalActor, companyId: string, taxPattern: RegExp | null = null): Promise<{ version: number }> {
    if (actor.portalRole !== 'owner') throw new ProfileError('NOT_ALLOWED', 'Only the owner of the vendor account can send the profile for review.');
    const sent = await this.db.transaction(async (tx) => {
      const v = await this.guard(tx, actor, 'profile');
      const loaded = await this.load(companyId, v.id);
      if (loaded === null) throw new ProfileError('NOT_FOUND', 'Your vendor account could not be found.');
      const state = this.toState(loaded, taxPattern);
      if (!profileComplete(state)) {
        const first = (['profile', 'business', 'financial', 'contacts', 'attachments'] as Section[]).flatMap((s) => missingIn(s, state))[0];
        throw new ProfileError('INCOMPLETE', first ?? 'Complete every section before you send your profile.');
      }
      const [latest] = await tx.select({ version: vendorProfileVersions.version }).from(vendorProfileVersions).where(eq(vendorProfileVersions.vendorId, v.id)).orderBy(desc(vendorProfileVersions.version)).limit(1);
      const version = (latest?.version ?? 0) + 1;
      const snapshot = {
        ...state,
        taxPattern: null,
        banks: loaded.banks.map((b) => ({ id: b.id, bankName: b.bankName, branch: b.branch, accountName: b.accountName, last4: b.accountLast4 })),
        documents: loaded.documents.map((d) => ({ id: d.doc.id, typeId: d.doc.documentTypeId, fileName: d.fileName, expiresOn: d.doc.expiresOn, status: d.doc.status })),
      };
      await tx.insert(vendorProfileVersions).values({ vendorId: v.id, version, snapshot, submittedBy: actor.userId });
      await tx.update(vendors).set({ status: 'profile_submitted', submittedAt: new Date(), reviewerId: null, updatedAt: new Date() }).where(eq(vendors.id, v.id));
      await this.event(tx, v.id, 'profile_submitted', actor, { version }, v.status, 'profile_submitted');
      return { version };
    });
    await this.notify?.applicationReceived(actor.vendorId, sent.version);
    return sent;
  }

  /** The note the reviewer left for each section on the last revision request (what to fix). */
  async revisionNotes(vendorId: string): Promise<Partial<Record<Section, string>>> {
    const [row] = await this.db
      .select({ notes: vendorProfileVersions.sectionNotes, decision: vendorProfileVersions.decision })
      .from(vendorProfileVersions)
      .where(eq(vendorProfileVersions.vendorId, vendorId))
      .orderBy(desc(vendorProfileVersions.version))
      .limit(1);
    return row?.decision === 'revision_requested' ? row.notes : {};
  }

  /** Reads sealed values for the person who must check them (never for the vendor's own screens). */
  openDirectorId(blob: Parameters<typeof decryptCredentials>[0]): string {
    const plain = decryptCredentials(blob);
    return typeof plain?.id === 'string' ? plain.id : '';
  }

  openBankNumber(blob: Parameters<typeof decryptCredentials>[0]): string {
    const plain = decryptCredentials(blob);
    return typeof plain?.number === 'string' ? plain.number : '';
  }
}
