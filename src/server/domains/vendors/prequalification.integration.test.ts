import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory, emptyQuestion, type CategoryForm } from '@/lib/prequalification';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { PortalActor } from './profile-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const TODAY = '2026-10-24';

describe.skipIf(!has(url))('prequalification (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  let catSeq = 0;

  const staff = (id: string): FinanceContext => ({ companyId, actor: { type: 'user', id }, origin: { surface: 'test', action: 'run' } });
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

  async function approvedVendor(): Promise<PortalActor> {
    seq += 1;
    const [u] = await db.insert(schema.users).values({ email: `pq${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `PQ Vendor ${run} ${String(seq)}`, email: `pq${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `Q${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `w${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
    for (const type of (await p.documentTypes(companyId)).filter((t) => t.requiredForAll)) {
      await p.addDocument(a, companyId, { documentTypeId: type.id, originalName: `${type.code}.pdf`, data: PDF, issuedOn: '2026-01-01', expiresOn: type.needsExpiry ? '2031-01-01' : '' });
    }
    await p.submit(a, companyId);
    const docs = await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.vendorId, vendorId));
    for (const d of docs) await c.vendorReview.verifyDocument(staff('reviewer'), d.id, 'valid', '');
    await c.vendorReview.approve(staff('reviewer'), vendorId);
    return a;
  }

  /** An open category with two scored questions (worth 10 and 20) and one that is not scored. */
  async function openCategory(over: Partial<CategoryForm> = {}, docTypeCodes: string[] = []) {
    catSeq += 1;
    const form: CategoryForm = { ...emptyCategory(), code: `CAT${String(catSeq)}_${run}`.toUpperCase(), name: `Category ${String(catSeq)} ${run}`, passMarkPercent: '60', ...over };
    const made = await c.categories.save(companyId, null, form);
    await c.categories.addQuestion(companyId, made.id, { ...emptyQuestion(), prompt: 'Do you hold ISO 9001?', kind: 'yes_no', weight: '10' });
    await c.categories.addQuestion(companyId, made.id, { ...emptyQuestion(), prompt: 'How many projects did you finish last year?', kind: 'number', weight: '20' });
    await c.categories.addQuestion(companyId, made.id, { ...emptyQuestion(), prompt: 'Anything else we should know?', kind: 'text', weight: '0', required: false });
    if (docTypeCodes.length > 0) {
      const types = (await c.vendorProfile.documentTypes(companyId)).filter((t) => docTypeCodes.includes(t.code));
      await c.categories.setDocuments(companyId, made.id, types.map((t) => t.id));
    }
    await c.categories.setStatus(companyId, made.id, 'open');
    const got = required(await c.categories.get(companyId, made.id));
    return { id: made.id, questions: got.questions };
  }

  const answersFor = (questions: { id: string; kind: string }[]) => Object.fromEntries(questions.filter((q) => q.kind !== 'text').map((q) => [q.id, q.kind === 'yes_no' ? 'yes' : '12']));

  async function submitted(a: PortalActor, cat: { id: string; questions: { id: string; kind: string }[] }) {
    const { ids } = await c.prequal.apply(a, companyId, [cat.id], TODAY);
    const entryId = required(ids[0]);
    await c.prequal.saveAnswers(a, entryId, answersFor(cat.questions));
    await c.prequal.submit(a, entryId);
    return entryId;
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
      .values({ legalName: 'PQ', tradingName: 'PQ', email: 'buyer@pq.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
  });

  describe('designing categories', () => {
    it('a category is a tree, never a loop, with questions and documents fixed once it opens', async () => {
      const parent = await c.categories.save(companyId, null, { ...emptyCategory(), code: `PARENT_${run}`.toUpperCase(), name: 'Parent' });
      const child = await c.categories.save(companyId, null, { ...emptyCategory(), code: `CHILD_${run}`.toUpperCase(), name: 'Child', parentId: parent.id });
      expect(await codeOf(c.categories.save(companyId, parent.id, { ...emptyCategory(), name: 'Parent', parentId: child.id }))).toBe('INVALID');
      expect(await codeOf(c.categories.save(companyId, parent.id, { ...emptyCategory(), name: 'Parent', parentId: parent.id }))).toBe('INVALID');
      expect(await codeOf(c.categories.save(companyId, null, { ...emptyCategory(), code: `PARENT_${run}`.toUpperCase(), name: 'Again' }))).toBe('DUPLICATE');
      expect(await codeOf(c.categories.addQuestion(companyId, child.id, { ...emptyQuestion(), prompt: 'Why?', kind: 'choice', choices: 'one' }))).toBe('INVALID');
      const q = await c.categories.addQuestion(companyId, child.id, { ...emptyQuestion(), prompt: 'Do you hold a licence?', kind: 'yes_no' });
      await c.categories.setStatus(companyId, child.id, 'open');
      expect(await codeOf(c.categories.addQuestion(companyId, child.id, { ...emptyQuestion(), prompt: 'One more question?' }))).toBe('LOCKED');
      expect(await codeOf(c.categories.removeQuestion(companyId, child.id, q.id))).toBe('LOCKED');
      expect(await codeOf(c.categories.setDocuments(companyId, child.id, []))).toBe('LOCKED');
      // The database refuses it too, whoever asks.
      expect(await codeOf(db.insert(schema.categoryQuestions).values({ categoryId: child.id, prompt: 'Sneaky', kind: 'text' }))).toBe('23001');
      expect(await codeOf(c.categories.setStatus(companyId, child.id, 'draft'))).toBe('NOT_ALLOWED');
    });

    it('an unknown document type or another company’s category is refused', async () => {
      const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `DOCS_${run}`.toUpperCase(), name: 'Docs' });
      expect(await codeOf(c.categories.setDocuments(companyId, cat.id, [randomUUID()]))).toBe('NOT_FOUND');
      expect(await c.categories.get(randomUUID(), cat.id)).toBeNull();
    });
  });

  describe('a vendor applies', () => {
    it('only an approved business applies, for several categories at once, once each', async () => {
      const one = await openCategory();
      const two = await openCategory();
      const fresh = await newUnapprovedVendor();
      expect(await codeOf(c.prequal.apply(fresh, companyId, [one.id], TODAY))).toBe('NOT_ACTIVE');
      const a = await approvedVendor();
      expect(await codeOf(c.prequal.apply({ ...a, portalRole: 'readonly' }, companyId, [one.id], TODAY))).toBe('NOT_ALLOWED');
      expect(await codeOf(c.prequal.apply(a, companyId, [], TODAY))).toBe('INVALID');
      const { ids } = await c.prequal.apply(a, companyId, [one.id, two.id], TODAY);
      expect(ids).toHaveLength(2);
      expect(await codeOf(c.prequal.apply(a, companyId, [one.id], TODAY))).toBe('ALREADY');
      const view = await c.prequal.open(companyId, a.vendorId, TODAY);
      expect(view.categories.find((x) => x.id === one.id)?.mine?.status).toBe('draft');
    });

    it('does not take applications outside the window or for a category that is not open', async () => {
      const closed = await openCategory({ windowTo: '2026-01-01' });
      const a = await approvedVendor();
      expect(await codeOf(c.prequal.apply(a, companyId, [closed.id], TODAY))).toBe('CLOSED');
      const draft = await c.categories.save(companyId, null, { ...emptyCategory(), code: `D_${run}${String(++catSeq)}`.toUpperCase(), name: 'Draft one' });
      expect(await codeOf(c.prequal.apply(a, companyId, [draft.id], TODAY))).toBe('CLOSED');
    });

    it('checks each answer, needs the required ones and the documents before it is sent', async () => {
      const cat = await openCategory({}, ['INSURANCE']);
      const a = await approvedVendor();
      const { ids } = await c.prequal.apply(a, companyId, [cat.id], TODAY);
      const id = required(ids[0]);
      const [yesNo, count] = cat.questions;
      expect(await codeOf(c.prequal.saveAnswers(a, id, { [required(yesNo).id]: 'maybe' }))).toBe('INVALID');
      await c.prequal.saveAnswers(a, id, { [required(yesNo).id]: 'yes' });
      expect(await codeOf(c.prequal.submit(a, id))).toBe('INCOMPLETE');
      await c.prequal.saveAnswers(a, id, { [required(yesNo).id]: 'yes', [required(count).id]: '12' });
      expect(await codeOf(c.prequal.submit(a, id))).toBe('DOCUMENTS_MISSING');
      const insurance = required((await c.vendorProfile.documentTypes(companyId)).find((t) => t.code === 'INSURANCE'));
      await c.vendorProfile.addDocument(a, companyId, { documentTypeId: insurance.id, originalName: 'insurance.pdf', data: PDF, issuedOn: '', expiresOn: '2030-01-01' });
      expect(await codeOf(c.prequal.submit(a, id))).toBe('OK');
      expect(await codeOf(c.prequal.saveAnswers(a, id, {}))).toBe('NOT_EDITABLE');
    });

    it('one vendor cannot read, change or withdraw another vendor’s application', async () => {
      const cat = await openCategory();
      const a = await approvedVendor();
      const b = await approvedVendor();
      const { ids } = await c.prequal.apply(a, companyId, [cat.id], TODAY);
      const id = required(ids[0]);
      expect(await codeOf(c.prequal.load(b, id))).toBe('NOT_FOUND');
      expect(await codeOf(c.prequal.saveAnswers(b, id, {}))).toBe('NOT_FOUND');
      expect(await codeOf(c.prequal.withdraw(b, id))).toBe('NOT_FOUND');
      expect(await codeOf(c.prequal.withdraw(a, id))).toBe('OK');
      expect(await codeOf(c.prequal.withdraw(a, id))).toBe('NOT_FOUND');
      // Withdrawn frees the place: the vendor can apply again.
      expect(await codeOf(c.prequal.apply(a, companyId, [cat.id], TODAY))).toBe('OK');
    });
  });

  async function newUnapprovedVendor(): Promise<PortalActor> {
    seq += 1;
    const [u] = await db.insert(schema.users).values({ email: `pn${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `PN Vendor ${run} ${String(seq)}`, email: `pn${String(seq)}.${run}@example.test`, phone: null });
    return { vendorId, userId: required(u).id, portalRole: 'owner' };
  }

  describe('evaluation and decision', () => {
    it('is scored by the people who took it, decided by someone else, and recorded with a validity', async () => {
      const cat = await openCategory({ validityMonths: '12' });
      const a = await approvedVendor();
      const entry = await submitted(a, cat);
      const [q1, q2] = cat.questions;
      expect(await codeOf(c.prequalReview.saveScores(staff('eva'), entry, [{ questionId: required(q1).id, score: 5, comment: '' }]))).toBe('NOT_IN_REVIEW');
      await c.prequalReview.take(staff('eva'), entry);
      expect(await codeOf(c.prequalReview.saveScores(staff('stranger'), entry, [{ questionId: required(q1).id, score: 5, comment: '' }]))).toBe('NOT_EVALUATOR');
      expect(await codeOf(c.prequalReview.saveScores(staff('eva'), entry, [{ questionId: required(q1).id, score: 11, comment: '' }]))).toBe('INVALID');
      expect(await codeOf(c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: '', note: '' }, TODAY))).toBe('NOT_SCORED');
      await c.prequalReview.saveScores(staff('eva'), entry, [{ questionId: required(q1).id, score: 2, comment: 'No certificate' }, { questionId: required(q2).id, score: 5, comment: '' }]);
      expect(await codeOf(c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: '', note: '' }, TODAY))).toBe('BELOW_PASS_MARK');
      expect(await codeOf(c.prequalReview.approve(staff('eva'), entry, { maxOrderValue: '', note: '' }, TODAY))).toBe('FOUR_EYES');
      await c.prequalReview.saveScores(staff('eva'), entry, [{ questionId: required(q1).id, score: 9, comment: '' }, { questionId: required(q2).id, score: 18, comment: 'Strong' }]);
      expect(await codeOf(c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: 'lots', note: '' }, TODAY))).toBe('INVALID');
      const done = await c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: '2000000', note: 'Up to KES 2M per order' }, TODAY);
      expect(done.validUntil).toBe('2027-10-23');
      const [row] = await db.select().from(schema.prequalEntries).where(eq(schema.prequalEntries.id, entry));
      expect(row).toMatchObject({ status: 'approved', validFrom: TODAY, validUntil: '2027-10-23', maxOrderValue: '2000000.00', totalScore: '27.00', maxScore: '30.00' });
      const events = (await db.select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendorId, a.vendorId))).map((e) => e.event);
      expect(events).toEqual(expect.arrayContaining(['prequalification_submitted', 'prequalification_review_started', 'prequalification_approved']));
      expect(await codeOf(c.prequalReview.reject(staff('boss'), entry, { code: 'PQ_NOT_RELEVANT' }))).toBe('NOT_SUBMITTED');
    });

    it('four eyes can be switched off for a category; a required document must be verified; the decision records why', async () => {
      const cat = await openCategory({ fourEyes: false, passMarkPercent: '' }, ['INSURANCE']);
      const a = await approvedVendor();
      const insurance = required((await c.vendorProfile.documentTypes(companyId)).find((t) => t.code === 'INSURANCE'));
      await c.vendorProfile.addDocument(a, companyId, { documentTypeId: insurance.id, originalName: 'insurance.pdf', data: PDF, issuedOn: '', expiresOn: '2030-01-01' });
      const entry = await submitted(a, cat);
      await c.prequalReview.take(staff('solo'), entry);
      expect(await codeOf(c.prequalReview.approve(staff('solo'), entry, { maxOrderValue: '', note: '' }, TODAY))).toBe('DOCUMENT_NOT_VERIFIED');
      const [doc] = await db.select().from(schema.vendorDocuments).where(and(eq(schema.vendorDocuments.vendorId, a.vendorId), eq(schema.vendorDocuments.documentTypeId, insurance.id)));
      await c.vendorReview.verifyDocument(staff('solo'), required(doc).id, 'valid', '');
      expect(await codeOf(c.prequalReview.approve(staff('solo'), entry, { maxOrderValue: '', note: '' }, TODAY))).toBe('OK');
    });

    it('refuses with a reason from the list, asks for changes, and the vendor corrects and sends again', async () => {
      const cat = await openCategory();
      const a = await approvedVendor();
      const rejected = await submitted(a, cat);
      expect(await codeOf(c.prequalReview.reject(staff('boss'), rejected, { code: 'PQ_OTHER' }))).toBe('COMMENT_REQUIRED');
      expect(await codeOf(c.prequalReview.reject(staff('boss'), rejected, { code: 'NOPE' }))).toBe('UNKNOWN_REASON');
      await c.prequalReview.reject(staff('boss'), rejected, { code: 'PQ_NOT_RELEVANT' });
      expect((await c.prequal.load(a, rejected)).result.reasonCode).toBe('PQ_NOT_RELEVANT');
      const again = await submitted(a, cat);
      await c.prequalReview.take(staff('eva'), again);
      expect(await codeOf(c.prequalReview.requestRevision(staff('boss'), again, '  ', ''))).toBe('NOTE_REQUIRED');
      await c.prequalReview.requestRevision(staff('boss'), again, 'Give the number of projects as a figure', '2026-12-01');
      const seen = await c.prequal.load(a, again);
      expect(seen.status).toBe('revision_requested');
      expect(seen.canEdit).toBe(true);
      expect(seen.result.comment).toMatch(/figure/);
      await c.prequal.saveAnswers(a, again, answersFor(cat.questions));
      await c.prequal.submit(a, again);
      expect((await c.prequal.load(a, again)).status).toBe('submitted');
    });

    it('shows the vendor only what the category allows of the scores', async () => {
      const hidden = await openCategory();
      const shown = await openCategory({ showTotalScore: true, showPassMark: true, showQuestionScores: true, showEvaluatorComments: true });
      const a = await approvedVendor();
      for (const cat of [hidden, shown]) {
        const entry = await submitted(a, cat);
        await c.prequalReview.take(staff('eva'), entry);
        await c.prequalReview.saveScores(staff('eva'), entry, [{ questionId: required(cat.questions[0]).id, score: 10, comment: 'Certificate seen' }, { questionId: required(cat.questions[1]).id, score: 20, comment: '' }]);
        await c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: '', note: '' }, TODAY);
      }
      const mine = await c.prequal.mine(a.vendorId);
      const view = async (name: string) => await c.prequal.load(a, required(mine.find((m) => m.categoryName.startsWith(name))).id);
      const h = await view(`Category ${  String(catSeq - 1)}`);
      const s = await view(`Category ${  String(catSeq)}`);
      expect(h.result.totalScore).toBeNull();
      expect(h.result.passMarkPercent).toBeNull();
      expect(h.questions.every((q) => q.score === null && q.comments.length === 0)).toBe(true);
      expect(s.result.totalScore).toBe('30.00');
      expect(s.result.passMarkPercent).toBe('60.00');
      expect(s.questions[0]?.score).toBe(10);
      expect(s.questions[0]?.comments).toEqual(['Certificate seen']);
    });
  });

  describe('what a qualification gates', () => {
    it('qualified vendors for a category include those qualified in a sub-category, until it ends, is suspended, or the vendor is blocked', async () => {
      const parent = await c.categories.save(companyId, null, { ...emptyCategory(), code: `GP_${run}${String(++catSeq)}`.toUpperCase(), name: 'Grand parent', passMarkPercent: '' });
      await c.categories.setStatus(companyId, parent.id, 'open');
      const childForm = { ...emptyCategory(), code: `GC_${run}${String(catSeq)}`.toUpperCase(), name: 'Grand child', parentId: parent.id };
      const child = await c.categories.save(companyId, null, childForm);
      await c.categories.setStatus(companyId, child.id, 'open');
      const a = await approvedVendor();
      const other = await approvedVendor();
      const { ids } = await c.prequal.apply(a, companyId, [child.id], TODAY);
      const entry = required(ids[0]);
      await c.prequal.submit(a, entry);
      await c.prequalReview.take(staff('eva'), entry);
      await c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: '500000', note: 'Small orders only' }, TODAY);

      expect(await c.prequalLifecycle.qualifiedVendorIds(companyId, parent.id, TODAY)).toContain(a.vendorId);
      expect(await c.prequalLifecycle.qualifiedVendorIds(companyId, child.id, TODAY)).toContain(a.vendorId);
      expect(await c.prequalLifecycle.qualifiedVendorIds(companyId, parent.id, TODAY)).not.toContain(other.vendorId);
      const q = await c.prequalLifecycle.qualificationOf(companyId, a.vendorId, parent.id, TODAY);
      expect(q).toMatchObject({ maxOrderValue: '500000.00', conditionsNote: 'Small orders only' });
      expect(await c.prequalLifecycle.qualificationOf(companyId, a.vendorId, parent.id, '2030-01-01')).toBeNull();

      await c.prequalReview.suspend(staff('boss'), entry, { code: 'PQ_PERFORMANCE', text: 'Late deliveries' });
      expect(await c.prequalLifecycle.qualifiedVendorIds(companyId, parent.id, TODAY)).not.toContain(a.vendorId);
      await c.prequalReview.reinstate(staff('boss'), entry);
      expect(await c.prequalLifecycle.qualifiedVendorIds(companyId, parent.id, TODAY)).toContain(a.vendorId);
      await db.update(schema.vendors).set({ block: 'all' }).where(eq(schema.vendors.id, a.vendorId));
      expect(await c.prequalLifecycle.qualifiedVendorIds(companyId, parent.id, TODAY)).not.toContain(a.vendorId);
      await db.update(schema.vendors).set({ block: 'none' }).where(eq(schema.vendors.id, a.vendorId));

      await c.prequalReview.revoke(staff('boss'), entry, { code: 'PQ_FAILED_CHECKS', text: 'Fake certificate' });
      expect(await c.prequalLifecycle.qualifiedVendorIds(companyId, parent.id, TODAY)).not.toContain(a.vendorId);
      expect(await codeOf(c.prequalReview.reinstate(staff('boss'), entry))).toBe('NOT_ALLOWED');
      // A revoked place is free again: the vendor may apply anew.
      expect(await codeOf(c.prequal.apply(a, companyId, [child.id], TODAY))).toBe('OK');
    });

    it('expires at the end of its validity and a renewal starts with the earlier answers', async () => {
      const cat = await openCategory({ validityMonths: '1', passMarkPercent: '' });
      const a = await approvedVendor();
      const entry = await submitted(a, cat);
      await c.prequalReview.take(staff('eva'), entry);
      await c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: '', note: '' }, TODAY);
      expect((await c.prequalLifecycle.run('2026-11-23')).expired).toBe(0);
      expect((await c.prequalLifecycle.run('2026-11-24')).expired).toBeGreaterThanOrEqual(1);
      expect(await c.prequalLifecycle.qualificationOf(companyId, a.vendorId, cat.id, '2026-11-24')).toBeNull();
      const { ids } = await c.prequal.apply(a, companyId, [cat.id], '2026-11-24');
      const renewal = await c.prequal.load(a, required(ids[0]));
      expect(renewal.questions.find((q) => q.kind === 'yes_no')?.answer).toBe('yes');
      const [row] = await db.select().from(schema.prequalEntries).where(eq(schema.prequalEntries.id, required(ids[0])));
      expect(row?.previousEntryId).toBe(entry);
    });

    it('is suspended when a blocking document expires and restored when a good one is uploaded', async () => {
      const cat = await openCategory({ passMarkPercent: '' }, ['TAX_COMPLIANCE']);
      const a = await approvedVendor();
      const entry = await submitted(a, cat);
      await c.prequalReview.take(staff('eva'), entry);
      await c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: '', note: '' }, TODAY);
      expect((await c.prequalLifecycle.run(TODAY)).suspended).toBe(0);

      await db.update(schema.vendorDocuments).set({ expiresOn: '2026-10-01' }).where(and(eq(schema.vendorDocuments.vendorId, a.vendorId), eq(schema.vendorDocuments.status, 'valid')));
      await c.vendorExpiry.run(TODAY);
      const lifecycle = await c.prequalLifecycle.run(TODAY);
      expect(lifecycle.suspended).toBeGreaterThanOrEqual(1);
      const [suspended] = await db.select().from(schema.prequalEntries).where(eq(schema.prequalEntries.id, entry));
      expect(suspended?.status).toBe('suspended');
      expect(suspended?.suspendedBecause).toMatch(/^document: /);
      expect(await c.prequalLifecycle.qualifiedVendorIds(companyId, cat.id, TODAY)).not.toContain(a.vendorId);

      const tax = required((await c.vendorProfile.documentTypes(companyId)).find((t) => t.code === 'TAX_COMPLIANCE'));
      await c.vendorProfile.addDocument(a, companyId, { documentTypeId: tax.id, originalName: 'tax2.pdf', data: PDF, issuedOn: '', expiresOn: '2031-01-01' });
      expect((await c.prequalLifecycle.run(TODAY)).restored).toBeGreaterThanOrEqual(1);
      const [back] = await db.select().from(schema.prequalEntries).where(eq(schema.prequalEntries.id, entry));
      expect(back?.status).toBe('approved');
      const events = (await db.select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendorId, a.vendorId))).map((e) => e.event);
      expect(events).toEqual(expect.arrayContaining(['prequalification_suspended', 'prequalification_reinstated']));
    });

    it('a category with live qualifications cannot be archived', async () => {
      const cat = await openCategory({ passMarkPercent: '' });
      const a = await approvedVendor();
      const entry = await submitted(a, cat);
      await c.prequalReview.take(staff('eva'), entry);
      await c.prequalReview.approve(staff('boss'), entry, { maxOrderValue: '', note: '' }, TODAY);
      await c.categories.setStatus(companyId, cat.id, 'closed');
      expect(await codeOf(c.categories.setStatus(companyId, cat.id, 'archived'))).toBe('IN_USE');
      expect(await codeOf(c.prequal.apply(await approvedVendor(), companyId, [cat.id], TODAY))).toBe('CLOSED');
    });
  });
});
