import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, required } from '@/lib/values';
import type * as PortalSession from './portal-session';
import type * as Guard from '@/server/domains/access-control/guard';
import { emptyBusiness, emptyFinancial, emptyProfile, type ProfileData } from '@/lib/vendor-profile';
import { emptyCategory } from '@/lib/prequalification';
import { emptyPoHeader, emptyPoLine, type PoLineForm } from '@/lib/purchase-order';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';
import type { PortalActor } from './profile-service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;


/**
 * The routes under `app/api`, called as the framework calls them. Only the session is replaced: who is signed in (a vendor of the
 * portal, a staff member who may or may not hold the permission) is set by each test; everything behind it is the real code.
 */
const who: { vendor: { vendorId: string; userId: string; portalRole: 'owner'; name: string } | null; allowed: boolean } = { vendor: null, allowed: true };
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers({ 'x-forwarded-for': '203.0.113.7' })) }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/server/domains/vendors/portal-session', async (original) => ({
  ...(await original<typeof PortalSession>()),
  requirePortalVendor: async () => {
    const { PortalAccessError: Denied } = await original<typeof PortalSession>();
    if (who.vendor === null) throw new Denied();
    return who.vendor;
  },
}));
vi.mock('@/server/domains/access-control/guard', async (original) => ({
  ...(await original<typeof Guard>()),
  requirePermission: async (key: string) => {
    const { AccessDeniedError: Denied } = await import('@/server/domains/access-control/engine');
    if (!who.allowed) throw new Denied(key, { allowed: false, reason: 'no_permission' } as never);
    return 'route-test-staff';
  },
}));

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const TODAY = new Date().toISOString().slice(0, 10);
const NO = { maySkipRfq: false, mayOverrideQualification: false };

describe.skipIf(!has(url))('the vendor routes (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  let companyId: string;
  let unit: { code: string; name: string };
  const run = randomUUID().slice(0, 6);
  let seq = 0;
  let catSeq = 0;
  let prodSeq = 0;

  const staff = (id: string): FinanceContext => ({ companyId, actor: { type: 'user', id }, origin: { surface: 'test', action: 'run' } });

  async function approvedVendor(): Promise<PortalActor> {
    seq += 1;
    const [u] = await db.insert(schema.users).values({ email: `ub${String(seq)}.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    const vendorId = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `UB Vendor ${run} ${String(seq)}`, email: `ub${String(seq)}.${run}@example.test`, phone: null });
    const a: PortalActor = { vendorId, userId: required(u).id, portalRole: 'owner' };
    const p = c.vendorProfile;
    const profile: ProfileData = { ...emptyProfile(), country: 'Kenya', description: 'We supply solar panels and inverters to businesses.', physicalStreet: '1 Mombasa Road', physicalCity: 'Nairobi', phone: '+254 700 000 000' };
    await p.saveProfile(a, profile);
    await p.saveBusiness(a, { ...emptyBusiness(), registrationNo: 'CPR/2012/12345', registrationDate: '2012-03-04', taxId: `G${String(Date.now()).slice(-9)}${String(seq % 10)}` });
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

  async function product(stock: number, cost: string): Promise<string> {
    prodSeq += 1;
    const itemTypeId = `itu_${run}_${String(prodSeq)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `UB-${run}-${String(prodSeq)}`.toUpperCase(), stockCode: `UBS-${run}-${String(prodSeq)}`.toUpperCase(), name: `Receiving ${String(prodSeq)}`, slug: `ub-${randomUUID()}`, itemTypeId, price: '999', costPrice: cost, stockQuantity: stock });
    return id;
  }

  /** A sent order with the lines given, for a qualified vendor; returns the order and its line ids. */
  async function sentOrder(v: PortalActor, lines: PoLineForm[], over: { currency?: string; confirm?: boolean } = {}) {
    catSeq += 1;
    const cat = await c.categories.save(companyId, null, { ...emptyCategory(), code: `UB${String(catSeq)}_${run}`.toUpperCase(), name: `UB category ${String(catSeq)} ${run}` });
    await c.categories.setStatus(companyId, cat.id, 'open');
    const { ids } = await c.prequal.apply(v, companyId, [cat.id], TODAY);
    await c.prequal.submit(v, required(ids[0]));
    await c.prequalReview.take(staff('evaluator'), required(ids[0]));
    await c.prequalReview.approve(staff('decider'), required(ids[0]), { maxOrderValue: '', note: '' }, TODAY);
    const { id } = await c.purchaseOrders.saveDraft(staff('buyer'), null, { ...emptyPoHeader(TODAY), vendorId: v.vendorId, categoryId: cat.id, currency: over.currency ?? 'KES', noRfqReason: 'Test' }, lines, false);
    await c.purchaseOrders.submit(staff('buyer'), id, NO);
    await c.purchaseOrders.approve(staff('boss'), id);
    await c.purchaseOrders.send(staff('buyer'), id);
    if (over.confirm === true) await c.purchaseOrders.recordConfirmation(staff('buyer'), id, 'Phone', new Date());
    const got = required(await c.purchaseOrders.get(companyId, id));
    return { id, lines: got.lines.map((l) => l.id), number: required(got.po.number) };
  }

  const stockLine = (productId: string, over: Partial<PoLineForm> = {}): PoLineForm => ({ ...emptyPoLine(), productId, description: 'Solar panel 450W', quantity: '10', unit: unit.code, unitPrice: '100', discountPercent: '10', taxRate: '16', ...over });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    const [company] = await db
      .insert(schema.companySettings)
      .values({ legalName: 'UB', tradingName: 'UB', email: 'buyer@ub.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(staff('reviewer'), 'kenya', { fiscalYearStart: '2026-01-01' });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const probe = await product(0, '1');
    const [p] = await db.select({ unitId: schema.products.baseUnitId }).from(schema.products).where(eq(schema.products.id, probe));
    const [u] = await db.select({ code: schema.unitsOfMeasure.code, name: schema.unitsOfMeasure.name }).from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, required(p).unitId));
    unit = required(u);
  });

  const asVendor = (v: PortalActor | null) => {
    who.vendor = v === null ? null : { vendorId: v.vendorId, userId: v.userId, portalRole: 'owner', name: 'Owner' };
    who.allowed = true;
  };
  const asStaff = (allowed: boolean) => {
    who.vendor = null;
    who.allowed = allowed;
  };
  const adminXml = async (id: string) => await (await import('../../../../app/api/admin/vendors/order-xml/[id]/route')).GET(new Request('http://localhost/x'), { params: Promise.resolve({ id }) });
  const vendorXml = async (id: string) => await (await import('../../../../app/api/vendor/order-xml/[id]/route')).GET(new Request('http://localhost/x'), { params: Promise.resolve({ id }) });
  const vendorFile = async (id: string) => await (await import('../../../../app/api/vendor/files/[id]/route')).GET(new Request('http://localhost/x'), { params: Promise.resolve({ id }) });
  const adminFile = async (id: string) => await (await import('../../../../app/api/admin/vendors/files/[id]/route')).GET(new Request('http://localhost/x'), { params: Promise.resolve({ id }) });
  const upload = async (form: FormData | null, headers: Record<string, string> = {}) => {
    const { POST } = await import('../../../../app/api/vendor/documents/route');
    return await POST(new Request('http://localhost/api/vendor/documents', { method: 'POST', body: form ?? 'not a form', headers }));
  };

  async function twoVendorsWithOrders() {
    const [a, b] = [await approvedVendor(), await approvedVendor()];
    const prod = await product(0, '10');
    const orderA = await sentOrder(a, [stockLine(prod)]);
    const orderB = await sentOrder(b, [stockLine(prod)]);
    return { a, b, orderA, orderB };
  }

  it('the staff order file: the right permission gets the XML, any other caller is refused, an odd id is just not found', async () => {
    const { orderA } = await twoVendorsWithOrders();
    asStaff(true);
    const ok = await adminXml(orderA.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('application/xml');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('cache-control')).toContain('no-store');
    expect(ok.headers.get('content-disposition')).toContain('attachment');
    expect(await ok.text()).toContain(orderA.number);
    expect((await adminXml('not-an-id')).status).toBe(404);
    expect((await adminXml(randomUUID())).status).toBe(404);
    asStaff(false);
    const refused = await adminXml(orderA.id);
    expect(refused.status).toBe(403);
    expect(refused.headers.get('cache-control')).toContain('no-store');
    expect(await refused.text()).not.toContain(orderA.number);
  });

  it('the vendor order file: a vendor gets its own order and nobody else\'s, a signed-out caller gets nothing', async () => {
    const { a, b, orderA, orderB } = await twoVendorsWithOrders();
    asVendor(a);
    expect((await vendorXml(orderA.id)).status).toBe(200);
    const other = await vendorXml(orderB.id);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain(orderB.number);
    expect((await vendorXml('x')).status).toBe(404);
    asVendor(b);
    expect((await vendorXml(orderB.id)).status).toBe(200);
    expect((await vendorXml(orderA.id)).status).toBe(404);
    asVendor(null);
    expect((await vendorXml(orderA.id)).status).toBe(401);
  });

  it('a vendor opens its own files only; the staff route needs its permission and is recorded', async () => {
    const [a, b] = [await approvedVendor(), await approvedVendor()];
    const mine = await c.invoicePortal.addFile(a, companyId, { originalName: 'scan.pdf', data: PDF });
    asVendor(a);
    const seen = await vendorFile(mine.id);
    expect(seen.status).toBe(200);
    expect(seen.headers.get('x-content-type-options')).toBe('nosniff');
    expect(seen.headers.get('content-security-policy')).toContain('sandbox');
    expect(seen.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await seen.arrayBuffer()).equals(PDF)).toBe(true);
    asVendor(b);
    expect((await vendorFile(mine.id)).status).toBe(404);
    expect((await vendorFile(randomUUID())).status).toBe(404);
    expect((await vendorFile('../../etc/passwd')).status).toBe(404);
    asVendor(null);
    expect((await vendorFile(mine.id)).status).toBe(404);
    asStaff(false);
    expect((await adminFile(mine.id)).status).toBe(403);
    asStaff(true);
    const staffSeen = await adminFile(mine.id);
    expect(staffSeen.status).toBe(200);
    expect(staffSeen.headers.get('content-security-policy')).toContain('sandbox');
    const opened = await db.select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendorId, a.vendorId));
    expect(opened.some((e) => e.event === 'file_opened')).toBe(true);
    expect((await adminFile(randomUUID())).status).toBe(404);
    expect((await adminFile('not-an-id')).status).toBe(404);
  });

  it('the document upload: a signed-out caller gets 401, a bad or oversize request is refused before it is read, a good one is stored for the signed-in vendor', async () => {
    const v = await approvedVendor();
    const type = required((await c.vendorProfile.documentTypes(companyId)).find((t) => !t.needsExpiry));
    const form = (name = 'cert.pdf', over: Record<string, string> = {}) => {
      const f = new FormData();
      f.set('file', new File([new Uint8Array(PDF)], name, { type: 'application/pdf' }));
      f.set('documentTypeId', type.id);
      for (const [k, val] of Object.entries(over)) f.set(k, val);
      return f;
    };
    asVendor(null);
    expect((await upload(form())).status).toBe(401);
    asVendor(v);
    expect((await upload(null)).status).toBe(400);
    const noFile = new FormData();
    noFile.set('documentTypeId', type.id);
    expect((await upload(noFile)).status).toBe(400);
    expect((await upload(form(), { 'content-length': String(500 * 1024 * 1024) })).status).toBe(413);
    const before = (await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.vendorId, v.vendorId))).length;
    const ok = await upload(form('new-cert.pdf'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
    expect((await db.select().from(schema.vendorDocuments).where(eq(schema.vendorDocuments.vendorId, v.vendorId))).length).toBe(before + 1);
    // Something that says it is a PDF but is not one is refused by its bytes, and the vendor is told why.
    const bad = new FormData();
    bad.set('file', new File([new TextEncoder().encode('<html><script>alert(1)</script></html>')], 'evil.pdf', { type: 'application/pdf' }));
    bad.set('documentTypeId', type.id);
    const refused = await upload(bad);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { ok: boolean }).ok).toBe(false);
  });
});
