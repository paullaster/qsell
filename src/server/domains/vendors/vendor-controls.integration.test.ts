import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { EmailMessage, EmailPort } from '@/server/ports/communications';
import type { PortalActor } from './profile-service';
import type { VendorBankChangeService } from './bank-change-service';
import type { VendorExpiryService } from './expiry-service';
import type { VendorInvitationService } from './invitation-service';
import type { VendorNotifier } from './notifier';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const dayFrom = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);

class Outbox implements EmailPort {
  readonly name = 'recorder';
  sent: EmailMessage[] = [];
  send(message: EmailMessage) {
    this.sent.push(message);
    return Promise.resolve({ messageId: 'x', provider: 'recorder' });
  }
}

describe.skipIf(!has(url))('vendor controls: bank change, standing, expiry, invitations (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let ctx: FinanceContext;
  let bank: VendorBankChangeService;
  let expiry: VendorExpiryService;
  let invites: VendorInvitationService;
  let notifier: VendorNotifier;
  const outbox = new Outbox();
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  /** Account numbers differ on every run, so a database that is reused still has no matching account elsewhere. */
  const stamp = String(Date.now()).slice(-9);

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

  async function newVendor(): Promise<PortalActor> {
    seq += 1;
    const [u] = await db.insert(schema.users).values({ email: `own${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `Control Vendor ${run} ${String(seq)}`, email: `own${String(seq)}.${run}@example.test`, phone: null });
    return { vendorId, userId: required(u).id, portalRole: 'owner' };
  }

  /** A vendor that has been through profile, review and approval, with one bank account in use. */
  async function approvedVendor(expires = dayFrom(new Date(), 300)): Promise<PortalActor> {
    const a = await newVendor();
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `P${String(Date.now()).slice(-9)}${String(seq % 10)}` });
    await p.addDirector(a, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(a, { bankName: 'KCB', branch: 'Moi Avenue', accountName: 'Acme Ltd', accountNumber: `0123${String(seq).padStart(6, '0')}`, swift: '' });
    await p.saveFinancial(a, { ...emptyFinancial(), offeredPaymentTermDays: '30' });
    await p.saveContacts(a, [{ name: 'Wanjiru Kamau', role: 'management', email: `w${String(seq)}.${run}@acme.test`, phone: '0700000000', isPrimary: true }]);
    for (const type of (await p.documentTypes(companyId)).filter((t) => t.requiredForAll)) {
      await p.addDocument(a, companyId, { documentTypeId: type.id, originalName: `${type.code}.pdf`, data: PDF, issuedOn: '2026-01-01', expiresOn: type.needsExpiry ? expires : '' });
    }
    await p.submit(a, companyId);
    const docs = await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.vendorId, a.vendorId));
    for (const d of docs) await c.vendorReview.verifyDocument(ctx, d.id, 'valid', '');
    await c.vendorReview.approve(ctx, a.vendorId);
    return a;
  }

  async function bankLetterOf(vendorId: string): Promise<string> {
    const loaded = await c.vendorProfile.load(companyId, vendorId);
    const type = required(loaded).types.find((t) => t.code === 'BANK_LETTER');
    return required(required(loaded).documents.find((d) => d.doc.documentTypeId === type?.id)).doc.id;
  }

  const newAccount = (n: number, replacesId: string, evidenceDocumentId: string) => ({ bankName: 'Equity', branch: 'Westlands', accountName: 'Acme Ltd', accountNumber: `${stamp}${String(n).padStart(2, '0')}`, swift: '', replacesId, evidenceDocumentId });

  async function activeAccountOf(vendorId: string) {
    const [row] = await db.select().from(schema.vendorBankAccounts).where(and(eq(schema.vendorBankAccounts.vendorId, vendorId), eq(schema.vendorBankAccounts.status, 'active')));
    return required(row);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const { VendorNotifier: Notifier } = await import('./notifier');
    const { VendorBankChangeService: Bank } = await import('./bank-change-service');
    const { VendorExpiryService: Expiry } = await import('./expiry-service');
    const { VendorInvitationService: Invites } = await import('./invitation-service');
    c = getContainer();
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'VC', tradingName: 'VC', email: 'buyer@vc.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P', publicBaseUrl: 'https://shop.test' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    ctx = staff('reviewer');
    await c.finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    notifier = new Notifier(db, outbox, c.companySettings);
    bank = new Bank(db, notifier);
    expiry = new Expiry(db, notifier);
    invites = new Invites(db, c.users, c.authTokens, notifier);
  });

  describe('changing bank details', () => {
    it('is a pending account that receives no money until it is approved and the cool-off has passed', async () => {
      const a = await approvedVendor();
      const old = await activeAccountOf(a.vendorId);
      const proposed = await bank.propose(a, newAccount(1, old.id, await bankLetterOf(a.vendorId)));
      const [row] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.id, proposed.id));
      expect(row?.status).toBe('pending_change');
      expect((await bank.payableAccounts(a.vendorId)).map((b) => b.id)).toEqual([old.id]);
      expect((await bank.forVendor(a.vendorId))[0]?.stage).toBe('awaiting_callback');
      expect(JSON.stringify(await bank.forVendor(a.vendorId))).not.toMatch(/sealed/);
      expect((await bank.worklist(companyId)).some((w) => w.id === proposed.id)).toBe(true);

      expect(await codeOf(bank.approve(staff('approver'), proposed.id))).toBe('CALLBACK_REQUIRED');
      expect(await codeOf(bank.recordCallback(staff('caller'), proposed.id, '  '))).toBe('NOTE_REQUIRED');
      await bank.recordCallback(staff('caller'), proposed.id, 'Phoned the finance manager on the number in our records; confirmed.');
      expect(await codeOf(bank.approve(staff('caller'), proposed.id))).toBe('FOUR_EYES');

      const friday = new Date('2026-10-23T09:00:00Z');
      const { effectiveFrom } = await bank.approve(staff('approver'), proposed.id, friday);
      expect(effectiveFrom.toISOString()).toBe('2026-10-28T09:00:00.000Z');
      expect((await bank.payableAccounts(a.vendorId, new Date('2026-10-27T09:00:00Z'))).map((b) => b.id)).toEqual([old.id]);
      expect((await bank.payableAccounts(a.vendorId, new Date('2026-10-28T09:00:00Z'))).map((b) => b.id)).toEqual([proposed.id]);
      const [retired] = await db.select().from(schema.vendorBankAccounts).where(eq(schema.vendorBankAccounts.id, old.id));
      expect(retired?.status).toBe('retired');
      const events = (await db.select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendorId, a.vendorId))).map((e) => e.event);
      expect(events).toEqual(expect.arrayContaining(['bank_change_proposed', 'bank_change_callback', 'bank_change_approved', 'bank_change_effective']));
    });

    it('the database itself refuses an approval by the proposer or the caller', async () => {
      const a = await approvedVendor();
      const proposed = await bank.propose(a, newAccount(2, '', await bankLetterOf(a.vendorId)));
      expect(await codeOf(db.update(schema.vendorBankAccounts).set({ approvedBy: a.userId, approvedAt: new Date() }).where(eq(schema.vendorBankAccounts.id, proposed.id)))).toBe('23514');
      await bank.recordCallback(staff('caller2'), proposed.id, 'Confirmed by phone.');
      expect(await codeOf(db.update(schema.vendorBankAccounts).set({ approvedBy: 'caller2', approvedAt: new Date() }).where(eq(schema.vendorBankAccounts.id, proposed.id)))).toBe('23514');
    });

    it('needs a bank letter, a vendor that is approved, the right role and only one change at a time', async () => {
      const a = await approvedVendor();
      const letter = await bankLetterOf(a.vendorId);
      expect(await codeOf(bank.propose({ ...a, portalRole: 'sales' }, newAccount(3, '', letter)))).toBe('NOT_ALLOWED');
      expect(await codeOf(bank.propose(a, newAccount(3, '', randomUUID())))).toBe('EVIDENCE_REQUIRED');
      const other = await approvedVendor();
      expect(await codeOf(bank.propose(a, newAccount(3, '', await bankLetterOf(other.vendorId))))).toBe('EVIDENCE_REQUIRED');
      expect(await codeOf(bank.propose(a, newAccount(3, randomUUID(), letter)))).toBe('NOT_FOUND');
      await bank.propose(a, newAccount(3, '', letter));
      expect(await codeOf(bank.propose(a, newAccount(4, '', letter)))).toBe('PENDING');
      const fresh = await newVendor();
      expect(await codeOf(bank.propose(fresh, newAccount(5, '', letter)))).toBe('NOT_EDITABLE');
    });

    it('a refused or withdrawn change leaves the existing account alone; the same account on another vendor is flagged', async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const old = await activeAccountOf(a.vendorId);
      const first = await bank.propose(a, newAccount(7, old.id, await bankLetterOf(a.vendorId)));
      await bank.propose(b, newAccount(7, '', await bankLetterOf(b.vendorId)));
      const flagged = (await bank.worklist(companyId)).find((w) => w.id === first.id);
      expect(flagged?.sameAccountOnOtherVendors).toBe(1);
      expect(await codeOf(bank.reject(staff('x'), first.id, ''))).toBe('NOTE_REQUIRED');
      await bank.reject(staff('x'), first.id, 'The letter does not match the account name.');
      expect((await bank.payableAccounts(a.vendorId)).map((r) => r.id)).toEqual([old.id]);
      expect(await codeOf(bank.recordCallback(staff('x'), first.id, 'late'))).toBe('NOT_PENDING');
      const again = await bank.propose(a, newAccount(8, old.id, await bankLetterOf(a.vendorId)));
      await bank.withdraw(a, again.id);
      expect(await codeOf(bank.withdraw(a, again.id))).toBe('NOT_FOUND');
      expect((await bank.payableAccounts(a.vendorId)).map((r) => r.id)).toEqual([old.id]);
    });

    it("one vendor cannot read or withdraw another vendor's change", async () => {
      const a = await approvedVendor();
      const b = await approvedVendor();
      const mine = await bank.propose(a, newAccount(9, '', await bankLetterOf(a.vendorId)));
      expect(await codeOf(bank.withdraw(b, mine.id))).toBe('NOT_FOUND');
      expect(await bank.forVendor(b.vendorId)).toEqual([]);
    });

    it('mails the vendor and the buyer about a request, and the vendor about the decision', async () => {
      const a = await approvedVendor();
      outbox.sent = [];
      const made = await bank.propose(a, newAccount(10, '', await bankLetterOf(a.vendorId)));
      expect(outbox.sent.map((m) => m.to)).toEqual(expect.arrayContaining([`own${String(seq)}.${run}@example.test`.toLowerCase(), 'buyer@vc.test']));
      expect(outbox.sent.every((m) => !(m.text ?? '').includes(stamp))).toBe(true);
      outbox.sent = [];
      await bank.reject(staff('x'), made.id, 'No letter match');
      expect(outbox.sent.some((m) => m.subject.includes('not accepted'))).toBe(true);
    });
  });

  describe('standing: suspend, block, archive', () => {
    it('suspends with a reason, hides nothing from history, and reinstates', async () => {
      const a = await approvedVendor();
      const lc = c.vendorLifecycle;
      expect(await codeOf(lc.suspend(ctx, a.vendorId, { code: 'VENDOR_DISPUTE' }))).toBe('COMMENT_REQUIRED');
      expect(await codeOf(lc.suspend(ctx, a.vendorId, { code: 'VENDOR_COMPLIANCE' }))).toBe('OK');
      expect(await codeOf(lc.suspend(ctx, a.vendorId, { code: 'VENDOR_COMPLIANCE' }))).toBe('NOT_ALLOWED');
      expect((await lc.standing(companyId, a.vendorId))?.reasonCode).toBe('VENDOR_COMPLIANCE');
      expect(await codeOf(lc.reinstate(ctx, a.vendorId))).toBe('OK');
      expect(await codeOf(lc.reinstate(ctx, a.vendorId))).toBe('NOT_ALLOWED');
      expect((await lc.standing(companyId, a.vendorId))?.reasonCode).toBeNull();
      const events = (await db.select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendorId, a.vendorId))).map((e) => e.event);
      expect(events).toEqual(expect.arrayContaining(['suspended', 'reinstated']));
    });

    it('blocks payments or everything, and unblocks', async () => {
      const a = await approvedVendor();
      const lc = c.vendorLifecycle;
      expect(await codeOf(lc.setBlock(ctx, a.vendorId, 'payment', { code: '' }))).toBe('REASON_REQUIRED');
      await lc.setBlock(ctx, a.vendorId, 'payment', { code: 'VENDOR_FRAUD_SUSPECTED', text: 'Bank change not confirmed' });
      expect((await lc.standing(companyId, a.vendorId))?.block).toBe('payment');
      expect(await codeOf(lc.setBlock(ctx, a.vendorId, 'payment', { code: 'VENDOR_OTHER', text: 'x' }))).toBe('NOT_ALLOWED');
      await lc.setBlock(ctx, a.vendorId, 'all', { code: 'VENDOR_OTHER', text: 'Investigation' });
      await lc.setBlock(ctx, a.vendorId, 'none', { code: '' });
      expect((await lc.standing(companyId, a.vendorId))?.block).toBe('none');
      expect(await codeOf(lc.setBlock(ctx, a.vendorId, 'bogus' as 'none', { code: '' }))).toBe('INVALID');
    });

    it('archives only when nothing is open, takes portal access away, and restores as suspended', async () => {
      const lc = c.vendorLifecycle;
      const open = await approvedVendor();
      await bank.propose(open, newAccount(11, '', await bankLetterOf(open.vendorId)));
      expect(await codeOf(lc.archive(ctx, open.vendorId, { code: 'VENDOR_AT_REQUEST' }))).toBe('BANK_CHANGE_OPEN');
      const submitted = await newVendor();
      await db.update(schema.vendors).set({ status: 'under_review' }).where(eq(schema.vendors.id, submitted.vendorId));
      expect(await codeOf(lc.archive(ctx, submitted.vendorId, { code: 'VENDOR_AT_REQUEST' }))).toBe('NOT_ALLOWED');

      const clean = await approvedVendor();
      expect(await codeOf(lc.archive(ctx, clean.vendorId, { code: 'VENDOR_AT_REQUEST' }))).toBe('OK');
      const { findPortalAccess } = await import('./portal-access');
      expect(await findPortalAccess(clean.userId)).toBeNull();
      expect(await codeOf(lc.setBlock(ctx, clean.vendorId, 'all', { code: 'VENDOR_OTHER', text: 'x' }))).toBe('NOT_ALLOWED');
      expect(await codeOf(lc.restore(ctx, clean.vendorId))).toBe('OK');
      expect((await lc.standing(companyId, clean.vendorId))?.status).toBe('suspended');
    });

    it('another company’s vendor cannot be touched', async () => {
      const a = await approvedVendor();
      const stranger: FinanceContext = { ...ctx, companyId: randomUUID() };
      expect(await codeOf(c.vendorLifecycle.reinstate(stranger, a.vendorId))).toBe('NOT_FOUND');
    });
  });

  describe('document expiry and reminders', () => {
    it('marks a document expired the day after its date, once, and tells the vendor', async () => {
      const a = await approvedVendor(dayFrom(new Date(), 400));
      const [doc] = await db.select().from(schema.vendorDocuments).where(and(eq(schema.vendorDocuments.vendorId, a.vendorId), eq(schema.vendorDocuments.status, 'valid')));
      const target = required(doc);
      await db.update(schema.vendorDocuments).set({ expiresOn: '2026-01-10' }).where(eq(schema.vendorDocuments.id, target.id));
      outbox.sent = [];
      const first = await expiry.run('2026-01-11');
      expect(first.expired).toBeGreaterThanOrEqual(1);
      const [after] = await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.id, target.id));
      expect(after?.status).toBe('expired');
      expect(outbox.sent.some((m) => m.subject.includes('has expired'))).toBe(true);
      expect((await expiry.run('2026-01-11')).expired).toBe(0);
      const events = (await db.select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendorId, a.vendorId))).filter((e) => e.event === 'document_expired');
      expect(events).toHaveLength(1);
      // It cannot be verified once expired.
      expect(await codeOf(c.vendorReview.verifyDocument(ctx, target.id, 'valid', ''))).toBe('EXPIRED');
    });

    it('reminds at each threshold once, only active vendors, and lists what is close', async () => {
      const a = await approvedVendor(dayFrom(new Date(), 400));
      const target = required((await db.select().from(schema.vendorDocuments).where(and(eq(schema.vendorDocuments.vendorId, a.vendorId), eq(schema.vendorDocuments.status, 'valid'))))[0]);
      await db.update(schema.vendorDocuments).set({ expiresOn: '2031-06-20' }).where(eq(schema.vendorDocuments.id, target.id));
      const mailsFor = () => outbox.sent.filter((m) => m.subject.includes('expires'));
      outbox.sent = [];
      await expiry.run('2031-05-01'); // 50 days left: nothing yet
      expect(mailsFor()).toHaveLength(0);
      await expiry.run('2031-05-25'); // 26 days: the 30-day reminder
      const thirty = mailsFor().length;
      expect(thirty).toBeGreaterThanOrEqual(1);
      await expiry.run('2031-05-26'); // same threshold: nothing more
      expect(mailsFor()).toHaveLength(thirty);
      await expiry.run('2031-06-15'); // 5 days: the 7-day reminder, also to the buyer
      expect(mailsFor().length).toBeGreaterThan(thirty);
      expect(outbox.sent.some((m) => m.to === 'buyer@vc.test')).toBe(true);
      const [row] = await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.id, target.id));
      expect(row?.lastReminderDay).toBe(7);

      const list = await expiry.expiring(companyId, { withinDays: 30 }, '2031-06-01');
      expect(list.rows.some((r) => r.id === target.id && r.daysLeft === 19)).toBe(true);
      const quiet = await expiry.expiring(companyId, { withinDays: 5 }, '2031-06-01');
      expect(quiet.rows.some((r) => r.id === target.id)).toBe(false);
    });

    it('pages the expiring list with a keyset cursor', async () => {
      const page1 = await expiry.expiring(companyId, { withinDays: 365, limit: 1 }, '2031-06-01');
      if (page1.next === null) return;
      const page2 = await expiry.expiring(companyId, { withinDays: 365, limit: 1, before: page1.next }, '2031-06-01');
      expect(page2.rows[0]?.id).not.toBe(page1.rows[0]?.id);
    });
  });

  describe('invitations', () => {
    it('the owner invites a colleague, who sets a password from the link and signs in', async () => {
      const a = await approvedVendor();
      outbox.sent = [];
      const email = `colleague.${run}.${String(seq)}@example.test`;
      await invites.inviteColleague(a, { email, name: 'Fiona Finance' }, 'finance');
      const mail = outbox.sent.find((m) => m.to === email);
      expect(mail?.html).toContain('https://shop.test/reset-password?token=');
      const token = /token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1] ?? '';
      expect(await c.accounts.resetPassword(token, 'Str0ng-Passw0rd!x')).toBe('ok');
      const user = await c.users.verifyPassword(email, 'Str0ng-Passw0rd!x');
      expect(user?.role).toBe('vendor');
      const { findPortalAccess } = await import('./portal-access');
      expect(await findPortalAccess(required(user).id)).toEqual({ vendorId: a.vendorId, portalRole: 'finance' });
      expect(await c.accounts.resetPassword(token, 'Another-Passw0rd!y')).toBe('invalid');
    });

    it('says nothing about an address that already has an account, and creates nothing', async () => {
      const a = await approvedVendor();
      const taken = `own1.${run}@example.test`;
      outbox.sent = [];
      await invites.inviteColleague(a, { email: taken, name: 'Someone Else' }, 'sales');
      expect(outbox.sent).toHaveLength(0);
      const team = await invites.team(a.vendorId);
      expect(team.map((t) => t.email)).not.toContain(taken);
    });

    it('only the owner invites, only to real roles, with a valid address', async () => {
      const a = await approvedVendor();
      expect(await codeOf(invites.inviteColleague({ ...a, portalRole: 'finance' }, { email: 'x@y.test', name: 'Xavier' }, 'sales'))).toBe('NOT_ALLOWED');
      expect(await codeOf(invites.inviteColleague(a, { email: 'x@y.test', name: 'Xavier' }, 'owner'))).toBe('INVALID');
      expect(await codeOf(invites.inviteColleague(a, { email: 'not-an-email', name: 'Xavier' }, 'sales'))).toBe('INVALID');
    });

    it('resends to someone who has not joined, and removes an unused invitation completely', async () => {
      const a = await approvedVendor();
      const email = `pending.${run}.${String(seq)}@example.test`;
      await invites.inviteColleague(a, { email, name: 'Pat Pending' }, 'readonly');
      const person = required((await invites.team(a.vendorId)).find((t) => t.email === email));
      expect(person.joined).toBe(false);
      outbox.sent = [];
      await invites.resend(a.vendorId, person.id);
      expect(outbox.sent).toHaveLength(1);
      await invites.remove(a.vendorId, person.id, { type: 'user', id: a.userId }, {});
      expect((await invites.team(a.vendorId)).map((t) => t.email)).not.toContain(email);
      expect(await c.users.findByEmail(email)).toBeNull();
    });

    it('removing someone who joined switches their login off; the owner and yourself cannot be removed', async () => {
      const a = await approvedVendor();
      const email = `joined.${run}.${String(seq)}@example.test`;
      outbox.sent = [];
      await invites.inviteColleague(a, { email, name: 'Jo Joined' }, 'sales');
      const token = /token=([A-Za-z0-9_-]{43})/.exec(outbox.sent[0]?.text ?? '')?.[1] ?? '';
      await c.accounts.resetPassword(token, 'Str0ng-Passw0rd!z');
      const person = required((await invites.team(a.vendorId)).find((t) => t.email === email));
      const owner = required((await invites.team(a.vendorId)).find((t) => t.role === 'owner'));
      expect(await codeOf(invites.remove(a.vendorId, owner.id, { type: 'user', id: 'someone' }, {}))).toBe('NOT_ALLOWED');
      await invites.remove(a.vendorId, person.id, { type: 'user', id: a.userId }, {});
      const { findPortalAccess } = await import('./portal-access');
      const user = required(await c.users.findByEmail(email));
      expect(await findPortalAccess(user.id)).toBeNull();
      expect(user.isActive).toBe(false);
      await expect(invites.resend(a.vendorId, person.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('staff invite the owner of a vendor they added, once, and cannot reach another company', async () => {
      const added = await c.vendors.createByStaff(ctx, { vendorType: 'company', legalName: `Walk-in ${run}`, tradingName: '', taxId: `A${run}00001Z`, country: 'Kenya', email: `walkin.${run}@example.test`, phone: '', paymentTermDays: '30', currency: '', approvedExpenseVendor: false, notes: '' }, true);
      outbox.sent = [];
      const email = `walkin.owner.${run}@example.test`;
      await invites.inviteOwner(ctx, added.id, { email, name: 'Wally Walkin' });
      expect(outbox.sent.some((m) => m.to === email)).toBe(true);
      expect(await codeOf(invites.inviteOwner(ctx, added.id, { email: `second.${run}@example.test`, name: 'Second Owner' }))).toBe('HAS_OWNER');
      expect(await codeOf(invites.inviteOwner({ ...ctx, companyId: randomUUID() }, added.id, { email: `x.${run}@example.test`, name: 'Xavier X' }))).toBe('NOT_FOUND');
    });
  });

  describe('document types', () => {
    it('creates one, refuses a duplicate code, and keeps the code fixed when editing', async () => {
      const svc = c.vendorDocumentTypes;
      await c.vendorProfile.documentTypes(companyId);
      const form = { code: `CLEAR_${run}`, name: 'Tax clearance', requiredForAll: false, needsExpiry: true, reminderDays: '60, 30', blocking: true, isActive: true };
      const made = await svc.save(companyId, null, form);
      expect(await codeOf(svc.save(companyId, null, form))).toBe('DUPLICATE');
      expect(await codeOf(svc.save(companyId, null, { ...form, code: `X_${run}`, needsExpiry: false }))).toBe('INVALID');
      await svc.save(companyId, made.id, { ...form, code: 'IGNORED', name: 'Tax clearance certificate', reminderDays: '45' });
      const row = required((await svc.list(companyId)).find((t) => t.id === made.id));
      expect(row.code).toBe(`CLEAR_${run}`.toUpperCase());
      expect(row.name).toBe('Tax clearance certificate');
      expect(row.reminderDays).toEqual([45]);
      expect(await codeOf(svc.save(randomUUID(), made.id, form))).toBe('NOT_FOUND');
    });
  });
});
