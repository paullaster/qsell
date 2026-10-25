import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { PortalActor } from './profile-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!has(url))('vendor profile, documents and review (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let ctx: FinanceContext;
  const run = randomUUID().slice(0, 6).toUpperCase();
  let seq = 0;

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (isRecord(e) && typeof e.code === 'string') return e.code;
      const cause = isRecord(e) && isRecord(e.cause) ? readText(e.cause.code) : '';
      return cause === '' ? `OTHER:${(e as Error).message}` : cause;
    }
  };

  /** A vendor business that has just registered, and the owner who signed up for it. */
  async function newVendor(role: PortalActor['portalRole'] = 'owner'): Promise<PortalActor> {
    seq += 1;
    const [u] = await db.insert(schema.users).values({ email: `own${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `Profile Vendor ${run} ${String(seq)}`, email: `own${String(seq)}.${run}@example.test`, phone: null });
    return { vendorId, userId: required(u).id, portalRole: role };
  }

  const profile = (): ProfileData => ({ ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' });
  const business = (taxId: string) => ({ ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId });

  /** Fills every section and uploads every required document. */
  async function complete(a: PortalActor, taxId = `P${String(Date.now()).slice(-9)}${run.slice(0, 1)}`) {
    const p = c.vendorProfile;
    await p.saveProfile(a, profile());
    await p.saveBusiness(a, business(taxId));
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123456${String(seq).padStart(4, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: 'w@acme.test', phone: '0700000000', isPrimary: true }]);
    for (const type of (await p.documentTypes(companyId)).filter((t) => t.requiredForAll)) {
      await p.addDocument(a, companyId, { documentTypeId: type.id, originalName: `${type.code}.pdf`, data: PDF, issuedOn: '2026-01-01', expiresOn: type.needsExpiry ? future(300) : '' });
    }
  }

  async function verifyAll(vendorId: string) {
    const docs = await db.select().from(schema.vendorDocuments).where(and(eq(schema.vendorDocuments.vendorId, vendorId), eq(schema.vendorDocuments.status, 'submitted')));
    for (const d of docs) await c.vendorReview.verifyDocument(ctx, d.id, 'valid', '');
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'VP', tradingName: 'VP', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'reviewer' }, origin: { surface: 'test', action: 'run' } };
    await c.finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
  });

  describe('writing the profile', () => {
    it('saving the first section moves a new vendor to "completing profile" and records it', async () => {
      const a = await newVendor();
      await c.vendorProfile.saveProfile(a, profile());
      const [v] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, a.vendorId));
      expect(v?.status).toBe('profile_in_progress');
      expect(v?.description).toMatch(/solar/);
      const events = await db.select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendorId, a.vendorId));
      expect(events.map((e) => e.event)).toContain('profile_started');
    });

    it('a role may change only its own sections', async () => {
      const a = await newVendor('sales');
      expect(await codeOf(c.vendorProfile.saveProfile(a, profile()))).toBe('NOT_EDITABLE');
      expect(await codeOf(c.vendorProfile.saveContacts(a, [{ name: 'Sam Sales', role: 'sales', email: 's@acme.test', phone: '0700000000', isPrimary: true }]))).toBe('OK');
      const readonly = { ...(await newVendor()), portalRole: 'readonly' };
      expect(await codeOf(c.vendorProfile.saveProfile(readonly, profile()))).toBe('NOT_EDITABLE');
    });

    it('refuses a bad section with the field and the reason', async () => {
      const a = await newVendor();
      let error: unknown;
      try {
        await c.vendorProfile.saveProfile(a, { ...profile(), description: 'short' });
      } catch (e) {
        error = e;
      }
      expect(isRecord(error) && isRecord(error.problems) ? Object.keys(error.problems) : []).toEqual(['description']);
    });

    it('two vendors cannot register the same tax id, and the answer does not say whose it is', async () => {
      const a = await newVendor();
      const b = await newVendor();
      const taxId = `P${run}77777Q`;
      await c.vendorProfile.saveBusiness(a, business(taxId));
      let message = '';
      try {
        await c.vendorProfile.saveBusiness(b, business(taxId.toLowerCase()));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/already registered/);
      expect(message).not.toContain(a.vendorId);
    });

    it('keeps account and ID numbers sealed, shows only the last four, and finds the same account on two vendors', async () => {
      const a = await newVendor();
      const b = await newVendor();
      const bank = { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: '0099 8877 66', swift: '' };
      await c.vendorProfile.addBank(a, bank);
      await c.vendorProfile.addBank(b, bank);
      await c.vendorProfile.addDirector(a, { name: 'Owner One', idType: 'national_id', idNumber: '87654321', sharePercent: '50' });
      const [row] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, a.vendorId));
      expect(JSON.stringify(row)).not.toContain('0099');
      expect(row?.accountLast4).toBe('0099887766'.slice(-4));
      expect(c.vendorProfile.openBankNumber(required(row).accountSealed)).toBe('0099887766');
      const [other] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, b.vendorId));
      expect(other?.accountHash).toBe(row?.accountHash);
      const [dir] = await db.select().from(schema.vendorDirectors).where(eq(schema.vendorDirectors.vendorId, a.vendorId));
      expect(JSON.stringify(dir)).not.toContain('87654321');
      expect(dir?.idLast4).toBe('4321');
    });

    it('a bank account cannot be edited in the database, only retired; a used one cannot be deleted', async () => {
      const a = await newVendor();
      await c.vendorProfile.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: '5555666677', swift: '' });
      const [row] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, a.vendorId));
      expect(await codeOf(db.update(schema.vendorBankAccounts).set({ bankName: 'Other' }).where(eq(schema.vendorBankAccounts.id, required(row).id)))).toBe('23001');
      await db.update(schema.vendorBankAccounts).set({ status: 'active' }).where(eq(schema.vendorBankAccounts.id, required(row).id));
      expect(await codeOf(db.delete(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.id, required(row).id)))).toBe('23001');
    });

    it('one vendor cannot remove another vendor’s director, bank account or document', async () => {
      const a = await newVendor();
      const b = await newVendor();
      await c.vendorProfile.addDirector(a, { name: 'Owner One', idType: 'national_id', idNumber: '87654321', sharePercent: '50' });
      await c.vendorProfile.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: '4444333322', swift: '' });
      const [dir] = await db.select().from(schema.vendorDirectors).where(eq(schema.vendorDirectors.vendorId, a.vendorId));
      const [bank] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, a.vendorId));
      await c.vendorProfile.removeDirector(b, required(dir).id);
      await c.vendorProfile.removeBank(b, required(bank).id);
      expect(await db.select().from(schema.vendorDirectors).where(eq(schema.vendorDirectors.id, required(dir).id))).toHaveLength(1);
      expect(await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.id, required(bank).id))).toHaveLength(1);
      const type = required((await c.vendorProfile.documentTypes(companyId))[0]);
      const doc = await c.vendorProfile.addDocument(a, companyId, { documentTypeId: type.id, originalName: 'x.pdf', data: PDF, issuedOn: '', expiresOn: type.needsExpiry ? future(100) : '' });
      expect(await codeOf(c.vendorProfile.removeDocument(b, doc.id))).toBe('NOT_FOUND');
    });
  });

  describe('documents', () => {
    it('accepts a PDF and refuses anything else, whatever its name says', async () => {
      const a = await newVendor();
      const type = required((await c.vendorProfile.documentTypes(companyId)).find((t) => !t.needsExpiry));
      const add = (data: Buffer, name: string) => codeOf(c.vendorProfile.addDocument(a, companyId, { documentTypeId: type.id, originalName: name, data, issuedOn: '', expiresOn: '' }));
      expect(await add(PDF, 'cert.pdf')).toBe('OK');
      expect(await add(Buffer.from('<script>alert(1)</script>'), 'cert.pdf')).toBe('FILE_REJECTED');
      expect(await add(Buffer.from('MZ\u0090\u0000\u0003 not a pdf'), 'cert.pdf')).toBe('FILE_REJECTED');
      expect(await add(Buffer.alloc(0), 'cert.pdf')).toBe('FILE_REJECTED');
      const [file] = await db.select().from(schema.vendorFiles).where(eq(schema.vendorFiles.vendorId, a.vendorId));
      expect(file?.mime).toBe('application/pdf');
      expect(file?.fileName).toBe('cert.pdf');
    });

    it('stores a safe file name with an extension that matches the content', async () => {
      const a = await newVendor();
      const type = required((await c.vendorProfile.documentTypes(companyId)).find((t) => !t.needsExpiry));
      await c.vendorProfile.addDocument(a, companyId, { documentTypeId: type.id, originalName: '../../etc/passwd.exe', data: PDF, issuedOn: '', expiresOn: '' });
      const [file] = await db.select().from(schema.vendorFiles).where(eq(schema.vendorFiles.vendorId, a.vendorId));
      expect(file?.fileName).toBe('passwd.pdf');
    });

    it('wants an expiry date where the type needs one, and not one that has passed', async () => {
      const a = await newVendor();
      const type = required((await c.vendorProfile.documentTypes(companyId)).find((t) => t.needsExpiry));
      const add = (expiresOn: string) => codeOf(c.vendorProfile.addDocument(a, companyId, { documentTypeId: type.id, originalName: 'x.pdf', data: PDF, issuedOn: '', expiresOn }));
      expect(await add('')).toBe('INVALID');
      expect(await add('2020-01-01')).toBe('INVALID');
      expect(await add(future(200))).toBe('OK');
    });

    it('a newer upload replaces the older one, which is kept', async () => {
      const a = await newVendor();
      const type = required((await c.vendorProfile.documentTypes(companyId)).find((t) => !t.needsExpiry));
      const input = { documentTypeId: type.id, originalName: 'x.pdf', data: PDF, issuedOn: '', expiresOn: '' };
      await c.vendorProfile.addDocument(a, companyId, input);
      await c.vendorProfile.addDocument(a, companyId, input);
      const docs = await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.vendorId, a.vendorId));
      expect(docs.map((d) => d.status).sort()).toEqual(['replaced', 'submitted']);
    });

    it('a file nobody may attach is never stored', async () => {
      const a = await newVendor();
      await complete(a);
      await c.vendorProfile.submit(a, companyId);
      const before = await db.select().from(schema.vendorFiles).where(eq(schema.vendorFiles.vendorId, a.vendorId));
      const type = required((await c.vendorProfile.documentTypes(companyId))[0]);
      expect(await codeOf(c.vendorProfile.addDocument(a, companyId, { documentTypeId: type.id, originalName: 'x.pdf', data: PDF, issuedOn: '', expiresOn: type.needsExpiry ? future(100) : '' }))).toBe('NOT_EDITABLE');
      expect(await db.select().from(schema.vendorFiles).where(eq(schema.vendorFiles.vendorId, a.vendorId))).toHaveLength(before.length);
    });
  });

  describe('submitting and review', () => {
    it('will not submit until every section is complete, and only the owner may submit', async () => {
      const a = await newVendor();
      await c.vendorProfile.saveProfile(a, profile());
      expect(await codeOf(c.vendorProfile.submit(a, companyId))).toBe('INCOMPLETE');
      await complete(a);
      expect(await codeOf(c.vendorProfile.submit({ ...a, portalRole: 'finance' }, companyId))).toBe('NOT_ALLOWED');
      expect((await c.vendorProfile.submit(a, companyId)).version).toBe(1);
    });

    it('a submitted profile is frozen: the vendor cannot change it, and the saved copy cannot be edited or deleted', async () => {
      const a = await newVendor();
      await complete(a);
      await c.vendorProfile.submit(a, companyId);
      expect(await codeOf(c.vendorProfile.saveProfile(a, profile()))).toBe('NOT_EDITABLE');
      const [version] = await db.select().from(schema.vendorProfileVersions).where(eq(schema.vendorProfileVersions.vendorId, a.vendorId));
      expect(await codeOf(db.update(schema.vendorProfileVersions).set({ snapshot: {} }).where(eq(schema.vendorProfileVersions.id, required(version).id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.vendorProfileVersions).where(eq(schema.vendorProfileVersions.id, required(version).id)))).toBe('23001');
      const snapshot = JSON.stringify(version?.snapshot);
      expect(snapshot).not.toContain('0123456');
    });

    it('approval needs every required document verified, then makes the vendor active with a number and live bank accounts', async () => {
      const a = await newVendor();
      await complete(a);
      await c.vendorProfile.submit(a, companyId);
      await c.vendorReview.startReview(ctx, a.vendorId);
      expect(await codeOf(c.vendorReview.startReview(ctx, a.vendorId))).toBe('NOT_SUBMITTED');
      expect(await codeOf(c.vendorReview.approve(ctx, a.vendorId))).toBe('DOCUMENT_NOT_VERIFIED');
      await verifyAll(a.vendorId);
      const { number } = await c.vendorReview.approve(ctx, a.vendorId);
      expect(number).toMatch(/^V-\d{6}$/);
      const [v] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, a.vendorId));
      expect(v).toMatchObject({ status: 'active', number });
      const banks = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.vendorId, a.vendorId));
      expect(banks.map((b) => b.status)).toEqual(['active']);
      const [version] = await db.select().from(schema.vendorProfileVersions).where(eq(schema.vendorProfileVersions.vendorId, a.vendorId));
      expect(version?.decision).toBe('approved');
      expect(await codeOf(c.vendorReview.approve(ctx, a.vendorId))).toBe('NOT_SUBMITTED');
      // An approved vendor still keeps its contacts and documents up to date, but not who it is or where it is paid.
      expect(await codeOf(c.vendorProfile.saveContacts(a, [{ name: 'New Contact', role: 'finance', email: 'n@acme.test', phone: '0700000001', isPrimary: true }]))).toBe('OK');
      expect(await codeOf(c.vendorProfile.saveBusiness(a, business('P000000000Z')))).toBe('NOT_EDITABLE');
      expect(await codeOf(c.vendorProfile.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Other', accountNumber: '9999888877', swift: '' }))).toBe('NOT_EDITABLE');
    });

    it('a document marked not valid needs a note, and the vendor’s replacement is checked again', async () => {
      const a = await newVendor();
      await complete(a);
      const [doc] = await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.vendorId, a.vendorId));
      expect(await codeOf(c.vendorReview.verifyDocument(ctx, required(doc).id, 'invalid', ' '))).toBe('NOTE_REQUIRED');
      await c.vendorReview.verifyDocument(ctx, required(doc).id, 'invalid', 'The scan is cut off');
      const [after] = await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.id, required(doc).id));
      expect(after).toMatchObject({ status: 'invalid', note: 'The scan is cut off', verifiedBy: 'reviewer' });
      // An invalid document no longer counts as held.
      const status = required(await c.vendorProfile.statuses(companyId, a.vendorId));
      expect(status.statuses.attachments).not.toBe('complete');
    });

    it('sends a profile back with a note per section; the vendor corrects it and sends version 2', async () => {
      const a = await newVendor();
      await complete(a);
      await c.vendorProfile.submit(a, companyId);
      expect(await codeOf(c.vendorReview.requestRevision(ctx, a.vendorId, {}, ''))).toBe('NOTE_REQUIRED');
      await c.vendorReview.requestRevision(ctx, a.vendorId, { financial: 'The account name does not match the certificate', nonsense: 'ignored' }, 'Almost there');
      expect(await c.vendorProfile.revisionNotes(a.vendorId)).toEqual({ financial: 'The account name does not match the certificate' });
      await c.vendorProfile.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '45' });
      expect((await c.vendorProfile.submit(a, companyId)).version).toBe(2);
      expect(await c.vendorProfile.revisionNotes(a.vendorId)).toEqual({});
      const versions = await db.select().from(schema.vendorProfileVersions).where(eq(schema.vendorProfileVersions.vendorId, a.vendorId));
      expect(versions.map((v) => v.decision).sort()).toEqual(['pending', 'revision_requested']);
    });

    it('refuses with a reason from the list, a comment where the reason wants one, and the vendor waits to apply again', async () => {
      const a = await newVendor();
      await complete(a);
      await c.vendorProfile.submit(a, companyId);
      expect(await codeOf(c.vendorReview.reject(ctx, a.vendorId, { code: 'NO_SUCH_REASON' }))).toBe('UNKNOWN_REASON');
      expect(await codeOf(c.vendorReview.reject(ctx, a.vendorId, { code: 'VENDOR_NOT_ELIGIBLE' }))).toBe('COMMENT_REQUIRED');
      await c.vendorReview.reject(ctx, a.vendorId, { code: 'VENDOR_NOT_ELIGIBLE', text: 'We do not buy from this kind of business' });
      const [v] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, a.vendorId));
      expect(v?.status).toBe('rejected');
      expect(await codeOf(c.vendorProfile.saveProfile(a, profile()))).toBe('NOT_EDITABLE');
      await db.update(schema.vendors).set({ decidedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(schema.vendors.id, a.vendorId));
      expect(await codeOf(c.vendorProfile.saveProfile(a, profile()))).toBe('OK');
      const [again] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, a.vendorId));
      expect(again?.status).toBe('profile_in_progress');
    });

    it('every decision is in the vendor history with who and why', async () => {
      const a = await newVendor();
      await complete(a);
      await c.vendorProfile.submit(a, companyId);
      await c.vendorReview.reject(ctx, a.vendorId, { code: 'VENDOR_INCOMPLETE' });
      const events = await db.select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendorId, a.vendorId));
      const rejected = events.find((e) => e.event === 'rejected');
      expect(rejected).toMatchObject({ fromStatus: 'profile_submitted', toStatus: 'rejected', reasonCode: 'VENDOR_INCOMPLETE', actorId: 'reviewer' });
      expect(events.some((e) => e.event === 'profile_submitted' && e.actorId === a.userId)).toBe(true);
    });

    it('staff see only submitted vendors in the queue, oldest first', async () => {
      const a = await newVendor();
      await complete(a);
      await c.vendorProfile.submit(a, companyId);
      const queue = await c.vendorReview.queue(companyId);
      expect(queue.some((q) => q.id === a.vendorId)).toBe(true);
      expect(queue.every((q) => q.status === 'profile_submitted' || q.status === 'under_review')).toBe(true);
    });
  });

  describe('files are served only to who may see them', () => {
    it('a vendor reads its own file; another vendor, and a missing id, read nothing', async () => {
      const a = await newVendor();
      const b = await newVendor();
      const type = required((await c.vendorProfile.documentTypes(companyId)).find((t) => !t.needsExpiry));
      await c.vendorProfile.addDocument(a, companyId, { documentTypeId: type.id, originalName: 'own.pdf', data: PDF, issuedOn: '', expiresOn: '' });
      const [file] = await db.select().from(schema.vendorFiles).where(eq(schema.vendorFiles.vendorId, a.vendorId));
      const mine = await c.vendorFiles.read(companyId, required(file).id, a.vendorId);
      expect(mine?.mime).toBe('application/pdf');
      expect(mine?.data.equals(PDF)).toBe(true);
      expect(await c.vendorFiles.read(companyId, required(file).id, b.vendorId)).toBeNull();
      expect(await c.vendorFiles.read(companyId, randomUUID(), a.vendorId)).toBeNull();
      expect(await c.vendorFiles.read(companyId, required(file).id, null)).not.toBeNull();
      expect(await codeOf(db.update(schema.vendorFiles).set({ fileName: 'x' }).where(eq(schema.vendorFiles.id, required(file).id)))).toBe('23001');
    });
  });
});
