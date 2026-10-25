/**
 * Makes a vendor business for one test and prints what the test needs as one line of JSON. Run with the end-to-end environment:
 *   tsx e2e/support/vendor-fixture.ts <tag> <mode>
 * `new` is a vendor that has just registered (verified login, nothing filled in); `submitted` has every section filled in,
 * every document uploaded, and the profile sent for review; `approved` is reviewed and active; `expiring` is approved with a
 * document that expires in five days; `bankpending` is approved with a bank change waiting for its call-back; `bankready` is
 * approved with a bank change whose call-back was recorded by someone else, so this session may approve it; `staffadded` is an
 * active vendor staff added, with nobody who can sign in. A new tag makes a new vendor, so a retried test starts clean.
 */
import { randomUUID } from 'node:crypto';
import { E2E_VENDOR_PASSWORD } from './constants';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function main(): Promise<void> {
  const [tag, mode] = process.argv.slice(2);
  const modes = ['new', 'submitted', 'approved', 'expiring', 'bankpending', 'bankready', 'staffadded'];
  if (tag === undefined || mode === undefined || !modes.includes(mode)) throw new Error(`usage: vendor-fixture <tag> ${modes.join('|')}`);
  const { getContainer } = await import('@/server/di/container');
  const { UserRepository } = await import('@/server/domains/auth/user-repository');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const email = `fixture-${tag}@example.test`;
  const legalName = `Fixture Vendor ${tag}`;
  if (mode === 'staffadded') {
    const ctx = { companyId: company.id, actor: { type: 'user' as const, id: 'e2e-fixture' }, origin: { surface: 'e2e', action: 'fixture' } };
    const made = await container.vendors.createByStaff(ctx, { vendorType: 'company', legalName, tradingName: '', taxId: `S${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`, country: 'Kenya', email, phone: '', paymentTermDays: '30', currency: '', approvedExpenseVendor: false, notes: '' }, true);
    process.stdout.write(`FIXTURE ${JSON.stringify({ email, password: E2E_VENDOR_PASSWORD, vendorId: made.id, legalName })}\n`);
    return;
  }
  const login = await new UserRepository().create({ email, password: E2E_VENDOR_PASSWORD, name: `Owner ${tag}`, role: 'vendor', emailVerified: true });
  const vendorId = await container.vendors.registerBusiness({ companyId: company.id, userId: login.id, legalName, email, phone: null });
  const out: Record<string, unknown> = { email, password: E2E_VENDOR_PASSWORD, vendorId, legalName };
  if (mode !== 'new') {
    const actor = { vendorId, userId: login.id, portalRole: 'owner' };
    const p = container.vendorProfile;
    await p.saveProfile(actor, { vendorType: 'company', tradingName: '', country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', yearEstablished: '', website: '', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', physicalCounty: '', physicalPostalCode: '', postalAddress: '', phone: '+254 700 000 000' });
    await p.saveBusiness(actor, { registrationNo: `CPR/${tag}`, registrationDate: '2012-03-04', taxId: `T${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`, vatNo: '', employeeCount: '', taxExempt: false });
    await p.addDirector(actor, { name: 'Wanjiru Kamau', idType: 'national_id', idNumber: '12345678', sharePercent: '100' });
    await p.addBank(actor, { bankName: 'KCB', branch: 'Moi Avenue', accountName: legalName, accountNumber: `00${String(Date.now()).slice(-9)}`, swift: '' });
    await p.saveFinancial(actor, { offeredPaymentTermDays: '30', turnoverBand: '', mobileMoneyNumber: '' });
    await p.saveContacts(actor, [{ name: 'Wanjiru Kamau', role: 'management', email, phone: '0700000000', isPrimary: true }]);
    const dayFrom = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    for (const type of (await p.documentTypes(company.id)).filter((t) => t.requiredForAll)) {
      // The tax compliance certificate is the one that runs out soon in `expiring`.
      const soon = mode === 'expiring' && type.code === 'TAX_COMPLIANCE';
      await p.addDocument(actor, company.id, { documentTypeId: type.id, originalName: `${type.code}.pdf`, data: PDF, issuedOn: '', expiresOn: type.needsExpiry ? dayFrom(soon ? 5 : 300) : '' });
    }
    await p.submit(actor, company.id);
    if (mode !== 'submitted') {
      const staff = { companyId: company.id, actor: { type: 'user' as const, id: 'e2e-fixture' }, origin: { surface: 'e2e', action: 'fixture' } };
      const docs = await db.select({ id: schema.vendorDocuments.id }).from(schema.vendorDocuments).where(eq(schema.vendorDocuments.vendorId, vendorId));
      for (const d of docs) await container.vendorReview.verifyDocument(staff, d.id, 'valid', '');
      const approved = await container.vendorReview.approve(staff, vendorId);
      out.number = approved.number;
      if (mode === 'bankpending' || mode === 'bankready') {
        const loaded = await p.load(company.id, vendorId);
        const letterType = loaded?.types.find((t) => t.code === 'BANK_LETTER');
        const letter = loaded?.documents.find((d) => d.doc.documentTypeId === letterType?.id);
        const old = loaded?.banks.find((b) => b.status === 'active');
        if (letter === undefined || old === undefined) throw new Error('the approved vendor has no bank letter or no active account');
        const number = `77${String(Date.now()).slice(-9)}`;
        const change = await container.vendorBank.propose(actor, { bankName: 'Equity Bank', branch: 'Westlands', accountName: legalName, accountNumber: number, swift: '', replacesId: old.id, evidenceDocumentId: letter.doc.id });
        out.changeId = change.id;
        out.newLast4 = number.slice(-4);
        if (mode === 'bankready') await container.vendorBank.recordCallback({ ...staff, actor: { type: 'user', id: 'e2e-caller' } }, change.id, 'Phoned the finance manager on the number in our records; confirmed.');
      }
    }
    const files = await db.select({ id: schema.vendorFiles.id }).from(schema.vendorFiles).where(eq(schema.vendorFiles.vendorId, vendorId));
    out.fileIds = files.map((f) => f.id);
  }
  process.stdout.write(`FIXTURE ${JSON.stringify(out)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
