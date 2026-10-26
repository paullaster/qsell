import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { blankQuoteLine, emptyRfqHeader, emptyRfqLine, type QuoteLineInput, type RfqHeaderForm } from '@/lib/rfq';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { EmailMessage, EmailPort } from '@/server/ports/communications';
import type { PortalActor } from './profile-service';
import type { VendorNotifier } from './notifier';
import type { RfqService } from './rfq-service';
import type { RfqPortalService } from './rfq-portal-service';
import type { RfqEvaluationService } from './rfq-evaluation-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const TODAY = new Date().toISOString().slice(0, 10);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);
/** The buyer's own clock, as a form would give it: the server reads these in its own time zone. */
const local = (d: Date) => {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};

class Outbox implements EmailPort {
  readonly name = 'recorder';
  sent: EmailMessage[] = [];
  send(message: EmailMessage) {
    this.sent.push(message);
    return Promise.resolve({ messageId: 'x', provider: 'recorder' });
  }
}

describe.skipIf(!has(url))('requests for quotation (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let rfqs: RfqService;
  let portal: RfqPortalService;
  let evaluation: RfqEvaluationService;
  let notifier: VendorNotifier;
  const outbox = new Outbox();
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
    const [u] = await db.insert(schema.users).values({ email: `rq${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `RFQ Vendor ${run} ${String(seq)}`, email: `rq${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `R${String(Date.now()).slice(-9)}${String(seq % 10)}` });
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

  async function newCategory(): Promise<string> {
    catSeq += 1;
    const made = await c.categories.save(companyId, null, { ...emptyCategory(), code: `RQ${String(catSeq)}_${run}`.toUpperCase(), name: `RFQ category ${String(catSeq)} ${run}` });
    await c.categories.setStatus(companyId, made.id, 'open');
    return made.id;
  }

  async function qualify(a: PortalActor, categoryId: string): Promise<void> {
    const { ids } = await c.prequal.apply(a, companyId, [categoryId], TODAY);
    const id = required(ids[0]);
    await c.prequal.submit(a, id);
    await c.prequalReview.take(staff('evaluator'), id);
    await c.prequalReview.approve(staff('decider'), id, { maxOrderValue: '', note: '' }, TODAY);
  }

  const header = (categoryId: string, over: Partial<RfqHeaderForm> = {}): RfqHeaderForm => ({ ...emptyRfqHeader(), title: `Solar kit ${run}`, categoryId, deadline: local(inHours(72)), currency: 'KES', validityDays: '30', ...over });
  const twoLines = [{ ...emptyRfqLine(), description: 'Inverter 5kW', quantity: '4', unit: 'each' }, { ...emptyRfqLine(), description: 'Cable 6mm', quantity: '100', unit: 'm' }];

  /** A request that is issued to the vendors given, all qualified in a new category. */
  async function issued(vendors: PortalActor[], over: Partial<RfqHeaderForm> = {}, issuedWith: PortalActor[] = vendors) {
    const categoryId = await newCategory();
    for (const v of vendors) await qualify(v, categoryId);
    const { id } = await rfqs.saveDraft(staff('buyer'), null, header(categoryId, over), twoLines);
    await rfqs.setInvitees(staff('buyer'), id, issuedWith.map((v) => v.vendorId), TODAY);
    await rfqs.issue(staff('buyer'), id);
    const got = required(await rfqs.get(companyId, id));
    return { id, categoryId, lineA: required(got.lines[0]).id, lineB: required(got.lines[1]).id };
  }

  const quote = (r: { lineA: string; lineB: string }, a: string, b: string, over: Partial<QuoteLineInput> = {}): QuoteLineInput[] => [
    { ...blankQuoteLine(r.lineA, 4), unitPrice: a, ...over },
    { ...blankQuoteLine(r.lineB, 100), unitPrice: b, ...over },
  ];
  const input = (lines: QuoteLineInput[], over: Partial<{ validUntil: string }> = {}) => ({ paymentTerms: '30 days', deliveryTerms: 'DAP Nairobi', validUntil: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10), notes: '', lines, ...over });

  /** Pretends the deadline has passed, as the clock cannot be moved. */
  async function passDeadline(rfqId: string) {
    await db.update(schema.rfqs).set({ deadline: new Date(Date.now() - 60_000), opensAt: new Date(Date.now() - 60_000) }).where(eq(schema.rfqs.id, rfqId));
    await rfqs.closeDue(new Date());
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const { VendorNotifier: Notifier } = await import('./notifier');
    const { RfqService: Svc } = await import('./rfq-service');
    const { RfqPortalService: Portal } = await import('./rfq-portal-service');
    const { RfqEvaluationService: Evaluation } = await import('./rfq-evaluation-service');
    c = getContainer();
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'RQ', tradingName: 'RQ', email: 'buyer@rq.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P', publicBaseUrl: 'https://shop.test' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    notifier = new Notifier(db, outbox, c.companySettings);
    rfqs = new Svc(db, c.numbering, c.prequalLifecycle, notifier);
    portal = new Portal(db, c.prequalLifecycle, notifier);
    evaluation = new Evaluation(db, rfqs, c.reasonCodes, notifier);
  });

  describe('the request as a document', () => {
    it('is written as a draft, invites only qualified vendors, and is fixed once issued', async () => {
      const qualified = await approvedVendor();
      const stranger = await approvedVendor();
      const categoryId = await newCategory();
      await qualify(qualified, categoryId);
      expect(await codeOf(rfqs.saveDraft(staff('buyer'), null, header(categoryId, { deadline: '' }), twoLines))).toBe('INVALID');
      expect(await codeOf(rfqs.saveDraft(staff('buyer'), null, header(categoryId), []))).toBe('INVALID');
      expect(await codeOf(rfqs.saveDraft(staff('buyer'), null, header(randomUUID()), twoLines))).toBe('NOT_FOUND');
      const { id } = await rfqs.saveDraft(staff('buyer'), null, header(categoryId), twoLines);
      expect(await codeOf(rfqs.issue(staff('buyer'), id))).toBe('NO_INVITEES');
      expect(await codeOf(rfqs.setInvitees(staff('buyer'), id, [stranger.vendorId], TODAY))).toBe('NOT_QUALIFIED');
      await rfqs.setInvitees(staff('buyer'), id, [qualified.vendorId], TODAY);
      expect(await codeOf(rfqs.saveDraft(staff('buyer'), id, header(categoryId, { deadline: local(inHours(0.2)) }), twoLines))).toBe('OK');
      expect(await codeOf(rfqs.issue(staff('buyer'), id))).toBe('DEADLINE_TOO_SOON');
      await rfqs.saveDraft(staff('buyer'), id, header(categoryId, { title: 'Solar kit, revised' }), twoLines);
      const done = await rfqs.issue(staff('buyer'), id);
      expect(done.number).toMatch(/^RFQ-\d{4}-\d{5}$/);
      expect(await codeOf(rfqs.saveDraft(staff('buyer'), id, header(categoryId), twoLines))).toBe('NOT_DRAFT');
      expect(await codeOf(rfqs.setInvitees(staff('buyer'), id, [], TODAY))).toBe('NOT_DRAFT');
      // The database refuses new lines on an issued request, whoever asks.
      expect(await codeOf(db.insert(schema.rfqLines).values({ rfqId: id, position: 9, description: 'Sneaky', quantity: '1' }))).toBe('23001');
      expect(await rfqs.get(randomUUID(), id)).toBeNull();
    });

    it('a vendor no longer qualified at issue time stops the issue', async () => {
      const a = await approvedVendor();
      const categoryId = await newCategory();
      await qualify(a, categoryId);
      const { id } = await rfqs.saveDraft(staff('buyer'), null, header(categoryId), twoLines);
      await rfqs.setInvitees(staff('buyer'), id, [a.vendorId], TODAY);
      const entry = required((await db.select().from(schema.prequalEntries).where(eq(schema.prequalEntries.vendorId, a.vendorId)))[0]);
      await c.prequalReview.revoke(staff('boss'), entry.id, { code: 'PQ_FAILED_CHECKS', text: 'Fake certificate' });
      expect(await codeOf(rfqs.issue(staff('buyer'), id))).toBe('NOT_QUALIFIED');
    });
  });

  describe('what a vendor can see', () => {
    it('only requests it was invited to, never drafts, and nothing of other vendors', async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const r = await issued([a, b], {}, [a]);
      expect((await portal.list(a.vendorId)).rows.map((x) => x.id)).toContain(r.id);
      expect((await portal.list(b.vendorId)).rows.map((x) => x.id)).not.toContain(r.id);
      expect(await codeOf(portal.load(b, r.id))).toBe('NOT_FOUND');
      expect(await codeOf(portal.saveDraft(b, r.id, input(quote(r, '10', '1'))))).toBe('NOT_FOUND');
      const draftCat = await newCategory();
      await qualify(a, draftCat);
      const draft = await rfqs.saveDraft(staff('buyer'), null, header(draftCat), twoLines);
      await rfqs.setInvitees(staff('buyer'), draft.id, [a.vendorId], TODAY);
      expect((await portal.list(a.vendorId)).rows.map((x) => x.id)).not.toContain(draft.id);
      expect(await codeOf(portal.load(a, draft.id))).toBe('NOT_FOUND');
      const view = await portal.load(a, r.id);
      expect(view.stage).toBe('in_progress');
      expect(JSON.stringify(view)).not.toMatch(/estimatedValue|buyerId|createdBy/);
    });
  });

  describe('a vendor’s quote', () => {
    it('is written, checked in full, totalled on the server, sent, and then never changes', async () => {
      const a = await approvedVendor();
      const r = await issued([a]);
      expect(await codeOf(portal.saveDraft({ ...a, portalRole: 'finance' }, r.id, input(quote(r, '10', '1'))))).toBe('NOT_ALLOWED');
      expect(await codeOf(portal.saveDraft(a, r.id, input(quote(r, 'free', '1'))))).toBe('INVALID');
      expect(await codeOf(portal.submit(a, r.id, companyId))).toBe('NO_DRAFT');
      await portal.saveDraft(a, r.id, input([{ ...blankQuoteLine(r.lineA, 4), unitPrice: '1250.50', taxRate: '16' }]));
      expect(await codeOf(portal.submit(a, r.id, companyId))).toBe('INCOMPLETE');
      expect(await codeOf(portal.saveDraft(a, r.id, input(quote(r, '1250.50', '2.25', { taxRate: '16' }), { validUntil: '2026-01-01' })))).toBe('OK');
      expect(await codeOf(portal.submit(a, r.id, companyId))).toBe('VALIDITY');
      await portal.saveDraft(a, r.id, input(quote(r, '1250.50', '2.25', { taxRate: '16' })));
      const sent = await portal.submit(a, r.id, companyId);
      expect(sent.version).toBe(1);
      const view = await portal.load(a, r.id);
      expect(view.stage).toBe('submitted');
      // 4 x 1250.50 + 100 x 2.25 = 5227.00; tax 16% = 836.32
      expect(view.submitted).toMatchObject({ subtotal: '5227.00', taxTotal: '836.32', total: '6063.32', version: 1 });
      expect(await codeOf(portal.saveDraft(a, r.id, input(quote(r, '1', '1'))))).toBe('SUBMITTED');
      // The database keeps a sent version as it was.
      const [row] = await db.select().from(schema.rfqQuotes).where(eq(schema.rfqQuotes.rfqId, r.id));
      expect(await codeOf(db.update(schema.rfqQuotes).set({ total: '1.00' }).where(eq(schema.rfqQuotes.id, required(row).id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.rfqQuotes).where(eq(schema.rfqQuotes.id, required(row).id)))).toBe('23001');
      expect(await codeOf(db.update(schema.rfqQuoteLines).set({ unitPrice: '1.00' }).where(eq(schema.rfqQuoteLines.quoteId, required(row).id)))).toBe('23001');
    });

    it('can be withdrawn and rewritten as a new version, with the old one kept', async () => {
      const a = await approvedVendor();
      const r = await issued([a]);
      await portal.saveDraft(a, r.id, input(quote(r, '10', '1')));
      await portal.submit(a, r.id, companyId);
      await portal.withdraw(a, r.id);
      expect((await portal.load(a, r.id)).stage).toBe('in_progress');
      await portal.saveDraft(a, r.id, input(quote(r, '9', '1')));
      const second = await portal.submit(a, r.id, companyId);
      expect(second.version).toBe(2);
      const view = await portal.load(a, r.id);
      expect(view.history.map((h) => [h.version, h.status])).toEqual([[2, 'submitted'], [1, 'withdrawn']]);
    });

    it('does not take a bid for more than asked, a partial quote when not allowed, or an alternative when not allowed', async () => {
      const a = await approvedVendor();
      const r = await issued([a]);
      expect(await codeOf(portal.saveDraft(a, r.id, input(quote(r, '10', '1', { quantity: '200' }))))).toBe('INVALID');
      const partial = quote(r, '10', '1');
      partial[0] = { ...required(partial[0]), quantity: '2' };
      expect(await codeOf(portal.saveDraft(a, r.id, input(partial)))).toBe('INVALID');
      expect(await codeOf(portal.saveDraft(a, r.id, input([...quote(r, '10', '1'), { ...blankQuoteLine(r.lineA, 4), isAlternative: true, unitPrice: '9' }])))).toBe('INVALID');
    });

    it('is refused once the deadline has passed, and by a vendor that is no longer qualified', async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const r = await issued([a, b]);
      await portal.saveDraft(b, r.id, input(quote(r, '10', '1')));
      const entry = required((await db.select().from(schema.prequalEntries).where(eq(schema.prequalEntries.vendorId, b.vendorId)))[0]);
      await c.prequalReview.revoke(staff('boss'), entry.id, { code: 'PQ_PERFORMANCE', text: 'Late deliveries' });
      expect(await codeOf(portal.submit(b, r.id, companyId))).toBe('NOT_QUALIFIED');
      await portal.saveDraft(a, r.id, input(quote(r, '10', '1')));
      await passDeadline(r.id);
      expect(await codeOf(portal.submit(a, r.id, companyId))).toBe('CLOSED');
      expect(await codeOf(portal.saveDraft(a, r.id, input(quote(r, '9', '1'))))).toBe('CLOSED');
      expect((await portal.load(a, r.id)).stage).toBe('expired');
    });

    it('can be declined with a reason unless a quote was sent', async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const r = await issued([a, b]);
      expect(await codeOf(portal.decline(a, r.id, ' '))).toBe('INVALID');
      await portal.decline(a, r.id, 'We do not stock this brand');
      expect((await portal.load(a, r.id)).stage).toBe('declined');
      expect(await codeOf(portal.saveDraft(a, r.id, input(quote(r, '10', '1'))))).toBe('CLOSED');
      await portal.saveDraft(b, r.id, input(quote(r, '10', '1')));
      await portal.submit(b, r.id, companyId);
      expect(await codeOf(portal.decline(b, r.id, 'Changed our mind'))).toBe('SUBMITTED');
    });
  });

  describe('sealed quotes', () => {
    it('are closed to staff before the deadline, show only a count, and open by the database clock afterwards', async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const r = await issued([a, b]);
      await portal.saveDraft(a, r.id, input(quote(r, '100', '2')));
      await portal.submit(a, r.id, companyId);
      const before = await evaluation.quotes(companyId, r.id);
      expect(before).toMatchObject({ sealed: true, received: 1 });
      expect(JSON.stringify(before)).not.toMatch(/RFQ Vendor|unitPrice|total/);
      expect(await codeOf(evaluation.decide(staff('buyer'), r.id, a.vendorId, 'accept', {}))).toBe('NOT_CLOSED');
      const [fn] = [...(await db.execute<{ open: boolean }>(sql`SELECT rfq_quotes_open(${r.id}::uuid) AS open`))];
      expect(fn?.open).toBe(false);
      await passDeadline(r.id);
      const open = await evaluation.quotes(companyId, r.id);
      expect(open.sealed).toBe(false);
    });

    it('an early close opens them at once, and a request whose quotes were opened cannot be reopened', async () => {
      const a = await approvedVendor();
      const r = await issued([a]);
      await portal.saveDraft(a, r.id, input(quote(r, '100', '2')));
      await portal.submit(a, r.id, companyId);
      expect(await codeOf(rfqs.closeEarly(staff('buyer'), r.id, ' '))).toBe('NOTE_REQUIRED');
      await rfqs.closeEarly(staff('buyer'), r.id, 'The need went away');
      expect((await evaluation.quotes(companyId, r.id)).sealed).toBe(false);
      expect(await codeOf(rfqs.extend(staff('buyer'), r.id, local(inHours(48)), 'More time'))).toBe('ALREADY_OPENED');
    });

    it('an open request can have its deadline extended, with an addendum and a fresh reminder cycle', async () => {
      const a = await approvedVendor();
      const r = await issued([a]);
      expect(await codeOf(rfqs.extend(staff('buyer'), r.id, local(inHours(1.5)), 'Sooner'))).toBe('INVALID');
      outbox.sent = [];
      await rfqs.extend(staff('buyer'), r.id, local(inHours(120)), 'Suppliers asked for time');
      const got = required(await rfqs.get(companyId, r.id));
      expect(got.addenda.map((x) => x.number)).toEqual([1]);
      expect(got.rfq.opensAt?.getTime()).toBe(got.rfq.deadline.getTime());
      expect(outbox.sent.some((m) => m.subject.startsWith('Update to RFQ-'))).toBe(true);
      const second = await rfqs.addendum(staff('buyer'), r.id, 'Delivery is to the Mombasa depot', '');
      expect(second.number).toBe(2);
      expect(await codeOf(db.update(schema.rfqAddenda).set({ body: 'changed' }).where(eq(schema.rfqAddenda.rfqId, r.id)))).toBe('23001');
    });
  });

  describe('questions', () => {
    it('are seen by the buyer alone; a published answer reaches every invitee without saying who asked', async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const r = await issued([a, b]);
      await portal.ask(a, r.id, 'Is the 6mm cable single core?');
      await portal.ask(a, r.id, 'May we deliver in two lots?');
      expect(await codeOf(portal.ask(a, r.id, 'no'))).toBe('INVALID');
      expect((await portal.load(b, r.id)).questions).toEqual([]);
      const staffView = required(await rfqs.get(companyId, r.id));
      expect(staffView.questions).toHaveLength(2);
      await rfqs.answer(staff('buyer'), required(staffView.questions[0]).q.id, 'Yes, single core.', true);
      await rfqs.answer(staff('buyer'), required(staffView.questions[1]).q.id, 'Private answer', false);
      const seenByB = await portal.load(b, r.id);
      expect(seenByB.questions).toHaveLength(1);
      expect(seenByB.questions[0]).toMatchObject({ answer: 'Yes, single core.', mine: false });
      expect(JSON.stringify(seenByB)).not.toContain(a.vendorId);
      const seenByA = await portal.load(a, r.id);
      expect(seenByA.questions.find((q) => q.answer === null)?.body).toMatch(/two lots/);
    });
  });

  describe('comparing, deciding and awarding', () => {
    async function threeQuotes() {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const d = await approvedVendor();
      const r = await issued([a, b, d]);
      await portal.saveDraft(a, r.id, input(quote(r, '1000', '2')));
      await portal.submit(a, r.id, companyId);
      await portal.saveDraft(b, r.id, input(quote(r, '900', '3')));
      await portal.submit(b, r.id, companyId);
      await portal.saveDraft(d, r.id, input([{ ...blankQuoteLine(r.lineA, 4), unitPrice: '950' }, { ...blankQuoteLine(r.lineB, 100), noBid: true }]));
      await portal.submit(d, r.id, companyId);
      await passDeadline(r.id);
      return { a, b, d, r };
    }

    it('shows the lowest on each line and the lowest complete quote, in cents', async () => {
      const { a, b, d, r } = await threeQuotes();
      const q = await evaluation.quotes(companyId, r.id);
      if (q.sealed) throw new Error('should be open');
      expect(q.sheet.rows).toEqual([{ lineId: r.lineA, lowest: [b.vendorId] }, { lineId: r.lineB, lowest: [a.vendorId] }]);
      const total = (v: PortalActor) => q.sheet.vendors.find((x) => x.vendorId === v.vendorId);
      expect(total(a)).toMatchObject({ total: 420000, complete: true });
      expect(total(b)).toMatchObject({ total: 390000, complete: true });
      expect(total(d)).toMatchObject({ complete: false });
      expect(q.sheet.lowestComplete).toEqual([b.vendorId]);
    });

    it('accepts, refuses with a reason the vendor is told, or asks for a revision that reopens the window for that vendor only', async () => {
      const { a, b, d, r } = await threeQuotes();
      expect(await codeOf(evaluation.decide(staff('buyer'), r.id, a.vendorId, 'reject', { reasonCode: 'RFQ_OTHER' }))).toBe('COMMENT_REQUIRED');
      outbox.sent = [];
      await evaluation.decide(staff('buyer'), r.id, a.vendorId, 'reject', { reasonCode: 'RFQ_PRICE' });
      expect((await portal.load(a, r.id)).decision).toMatchObject({ value: 'rejected', reason: 'The price is higher than we can accept' });
      expect(outbox.sent.some((m) => m.subject.includes('was not accepted'))).toBe(true);
      expect(await codeOf(evaluation.decide(staff('buyer'), r.id, d.vendorId, 'revise', { text: '', due: local(inHours(24)) }))).toBe('NOTE_REQUIRED');
      expect(await codeOf(evaluation.decide(staff('buyer'), r.id, d.vendorId, 'revise', { text: 'Quote the cable too', due: local(inHours(0.1)) }))).toBe('INVALID');
      await evaluation.decide(staff('buyer'), r.id, d.vendorId, 'revise', { text: 'Quote the cable too', due: local(inHours(24)) });
      const asked = await portal.load(d, r.id);
      expect(asked.stage).toBe('revision_requested');
      expect(asked.window.open).toBe(true);
      expect((await portal.load(b, r.id)).window.open).toBe(false);
      await portal.saveDraft(d, r.id, input(quote(r, '950', '2.5')));
      const v2 = await portal.submit(d, r.id, companyId);
      expect(v2.version).toBe(2);
      const after = await portal.load(d, r.id);
      expect(after.decision.value).toBe('pending');
      expect(after.history.map((h) => h.version)).toEqual([2, 1]);
      const sheet = await evaluation.quotes(companyId, r.id);
      if (sheet.sealed) throw new Error('should be open');
      expect(sheet.vendors.find((x) => x.vendorId === d.vendorId)?.quote?.version).toBe(2);
      expect(await codeOf(evaluation.decide(staff('buyer'), r.id, randomUUID(), 'accept', {}))).toBe('NOT_FOUND');
    });

    it('awards line by line; a vendor who is not the lowest needs a justification; quantities are bounded', async () => {
      const { a, b, r } = await threeQuotes();
      expect(await codeOf(evaluation.award(staff('buyer'), r.id, [], ''))).toBe('INVALID');
      expect(await codeOf(evaluation.award(staff('buyer'), r.id, [{ rfqLineId: r.lineA, vendorId: a.vendorId, quantity: '5' }], 'x'))).toBe('INVALID');
      expect(await codeOf(evaluation.award(staff('buyer'), r.id, [{ rfqLineId: r.lineA, vendorId: a.vendorId, quantity: '3' }, { rfqLineId: r.lineA, vendorId: b.vendorId, quantity: '2' }], 'x'))).toBe('INVALID');
      expect(await codeOf(evaluation.award(staff('buyer'), r.id, [{ rfqLineId: r.lineA, vendorId: a.vendorId, quantity: '4' }], ''))).toBe('JUSTIFICATION_REQUIRED');
      outbox.sent = [];
      const done = await evaluation.award(staff('buyer'), r.id, [{ rfqLineId: r.lineA, vendorId: b.vendorId, quantity: '2' }, { rfqLineId: r.lineA, vendorId: a.vendorId, quantity: '2' }, { rfqLineId: r.lineB, vendorId: a.vendorId, quantity: '100' }], 'Split the order for supply security');
      expect(done.awarded).toBe(3);
      const got = required(await rfqs.get(companyId, r.id));
      expect(got.rfq.status).toBe('awarded');
      expect((await evaluation.awards(companyId, r.id)).map((x) => [x.vendorName.slice(-1), x.quantity, x.unitPrice])).toEqual(expect.arrayContaining([[String(seq - 1).slice(-1), '2.000', '900.00']]));
      expect((await portal.load(a, r.id)).stage).toBe('awarded');
      expect((await portal.load(a, r.id)).awards).toHaveLength(2);
      const bView = await portal.load(b, r.id);
      expect(bView.awards).toHaveLength(1);
      expect(JSON.stringify(bView)).not.toMatch(/1000\.00|950\.00/);
      // Each vendor's own address and its named contact: two messages a vendor.
      expect(outbox.sent.filter((m) => m.subject.startsWith('You were awarded'))).toHaveLength(4);
      expect(outbox.sent.filter((m) => m.subject.startsWith('Result of'))).toHaveLength(2);
      expect(await codeOf(evaluation.award(staff('buyer'), r.id, [{ rfqLineId: r.lineA, vendorId: b.vendorId, quantity: '1' }], 'again'))).toBe('NOT_CLOSED');
      expect(await codeOf(db.delete(schema.rfqAwards).where(eq(schema.rfqAwards.rfqId, r.id)))).toBe('23001');
      expect(await codeOf(rfqs.cancel(staff('buyer'), r.id, 'oops'))).toBe('NOT_ALLOWED');
    });

    it('will not award a line a vendor did not bid on, or to a vendor whose quote was refused', async () => {
      const { a, d, r } = await threeQuotes();
      expect(await codeOf(evaluation.award(staff('buyer'), r.id, [{ rfqLineId: r.lineB, vendorId: d.vendorId, quantity: '10' }], 'x'))).toBe('NO_BID');
      await evaluation.decide(staff('buyer'), r.id, a.vendorId, 'reject', { reasonCode: 'RFQ_PRICE' });
      expect(await codeOf(evaluation.award(staff('buyer'), r.id, [{ rfqLineId: r.lineA, vendorId: a.vendorId, quantity: '1' }], 'x'))).toBe('NO_BID');
    });

    it('holds an award for an approval workflow: nothing is awarded until it is approved, a refusal drops the proposal', async () => {
      const mk = async (label: string) => required((await db.insert(schema.users).values({ email: `${label}-${randomUUID()}@example.test`, passwordHash: 'x', name: label, role: 'manager' }).returning())[0]).id;
      const [owner, buyer] = await Promise.all([mk('boss'), mk('buyer')]);
      const actor = { type: 'user' as const, id: 'wf-test' };
      const reason = { code: 'POLICY_CHANGE' };
      await c.approvalConfig.saveProfile(companyId, { userId: owner, limits: [] }, actor, reason);
      const wf = await c.approvalConfig.createWorkflow(companyId, { code: `W-${randomUUID().slice(0, 8)}`, name: 'Award test', trigger: 'rfq.award' }, actor);
      await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'eq', field: 'vendors', value: 1 }, steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: owner } }] } as never, actor);
      await c.approvalConfig.publish(companyId, wf.id, actor, reason);
      try {
        const { b, r } = await threeQuotes();
        const choice = [{ rfqLineId: r.lineA, vendorId: b.vendorId, quantity: '2' }];
        const entryOf = async () => required((await c.approvals.forDocument(companyId, 'rfq_award', r.id)).flatMap((x) => x.entries).find((e) => e.status === 'open'));
        const status = async () => required(await rfqs.get(companyId, r.id)).rfq.status;
        outbox.sent = [];
        expect(await evaluation.award(staff(buyer), r.id, choice, '')).toEqual({ awarded: 0, pending: true });
        expect(await status()).toBe('closed');
        expect(await evaluation.awards(companyId, r.id)).toHaveLength(0);
        expect(outbox.sent.filter((m) => m.subject.startsWith('You were awarded'))).toHaveLength(0);
        expect(await codeOf(evaluation.award(staff(buyer), r.id, choice, ''))).toBe('AWARD_PENDING');
        expect(await codeOf(evaluation.decide(staff(buyer), r.id, b.vendorId, 'accept', {}))).toBe('AWARD_PENDING');
        await db.transaction(async (tx) => await c.approvals.reject((await entryOf()).id, owner, { reasonCode: 'OTHER', comment: 'Ask for a better price' }, tx));
        expect(await evaluation.awardWaiting(db, r.id)).toBe(false);
        expect(await status()).toBe('closed');
        expect(await evaluation.award(staff(buyer), r.id, choice, '')).toEqual({ awarded: 0, pending: true });
        const { withAfterCommit } = await import('@/server/kernel/after-commit');
        await withAfterCommit(db, async (tx) => await c.approvals.approve((await entryOf()).id, owner, null, tx));
        expect(await status()).toBe('awarded');
        expect(await evaluation.awards(companyId, r.id)).toHaveLength(1);
        expect((await evaluation.awards(companyId, r.id))[0]).toMatchObject({ vendorId: b.vendorId, quantity: '2.000' });
      } finally {
        await c.approvalConfig.setWorkflowStatus(companyId, wf.id, 'disabled', actor, reason);
      }
    });
  });

  describe('cancelling and reminders', () => {
    it('a cancelled request tells the invitees why and takes no more quotes', async () => {
      const a = await approvedVendor();
      const r = await issued([a]);
      expect(await codeOf(rfqs.cancel(staff('buyer'), r.id, ' '))).toBe('NOTE_REQUIRED');
      outbox.sent = [];
      await rfqs.cancel(staff('buyer'), r.id, 'Budget withdrawn');
      expect(outbox.sent.some((m) => m.subject.includes('is cancelled') && (m.text ?? '').includes('Budget withdrawn'))).toBe(true);
      expect((await portal.load(a, r.id)).stage).toBe('cancelled');
      expect(await codeOf(portal.saveDraft(a, r.id, input(quote(r, '1', '1'))))).toBe('CLOSED');
    });

    it('reminds vendors who have not quoted, once, and not those who have', async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const r = await issued([a, b], { deadline: local(inHours(3)) });
      await portal.saveDraft(a, r.id, input(quote(r, '10', '1')));
      await portal.submit(a, r.id, companyId);
      outbox.sent = [];
      const first = await rfqs.remind(new Date());
      expect(first).toBeGreaterThanOrEqual(1);
      expect(outbox.sent.some((m) => m.to.startsWith(`rq${String(seq)}.`))).toBe(true);
      expect(outbox.sent.some((m) => m.to.startsWith(`rq${String(seq - 1)}.`))).toBe(false);
      const [row] = await db.select().from(schema.rfqs).where(eq(schema.rfqs.id, r.id));
      expect([row?.reminded4, row?.reminded48]).toEqual([true, true]);
      outbox.sent = [];
      await rfqs.remind(new Date());
      expect(outbox.sent.filter((m) => m.subject.includes('are due in'))).toHaveLength(0);
    });
  });
});
