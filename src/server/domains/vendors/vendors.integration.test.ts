import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { has, isRecord, readText, required } from '@/lib/values';
import { emptyVendorCreation } from '@/lib/vendor-forms';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { FinanceContext } from '@/server/domains/finance/errors';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('vendors and the vendor ledger (database)', () => {
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
      if (isRecord(e) && 'code' in e) return readText(e.code);
      const cause = isRecord(e) && isRecord(e.cause) ? readText(e.cause.code) : '';
      return cause === '' ? `OTHER:${(e as Error).message}` : cause;
    }
  };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

  async function vendor(over: Partial<ReturnType<typeof emptyVendorCreation>> = {}, activate = true) {
    seq += 1;
    return await c.vendors.createByStaff(ctx, { ...emptyVendorCreation(), legalName: `Vendor ${run} ${seq}`, email: `v${seq}.${run}@example.test`, ...over }, activate);
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
      .values({ legalName: 'VM', tradingName: 'VM', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' })
      .returning();
    companyId = required(company).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin: { surface: 'test', action: 'run' } };
    await c.finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
  });

  describe('the vendor master', () => {
    it('an active vendor gets its number when it is made active, and a registered one has none yet', async () => {
      const active = await vendor({}, true);
      const waiting = await vendor({}, false);
      expect(active.number).toMatch(/^V-\d{6}$/);
      expect(waiting.number).toBeNull();
      const [row] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, waiting.id));
      expect(row?.status).toBe('registered');
      expect(row?.postingGroupId).not.toBeNull();
    });

    it('the first vendor numbers run on without gaps', async () => {
      const a = await vendor({}, true);
      const b = await vendor({}, true);
      expect(Number(required(b.number).slice(2)) - Number(required(a.number).slice(2))).toBe(1);
    });

    it('refuses a second vendor with the same tax id, whatever the case or spacing', async () => {
      await vendor({ taxId: `p05 ${run}1x` });
      expect(await codeOf(vendor({ taxId: `P05${run}1X` }))).toBe('VENDOR_DUPLICATE');
    });

    it('a vendor in good standing always has a number (the database refuses otherwise)', async () => {
      const v = await vendor({}, false);
      expect(await codeOf(db.update(schema.vendors).set({ status: 'active' }).where(eq(schema.vendors.id, v.id)))).toBe('23514');
    });

    it('every step is written to the vendor history', async () => {
      const v = await vendor({}, true);
      const found = required(await c.vendors.get(companyId, v.id));
      expect(found.events.map((e) => e.event).sort()).toEqual(['activated', 'created_by_staff']);
      expect(await codeOf(db.update(schema.vendorEvents).set({ event: 'x' }).where(eq(schema.vendorEvents.vendorId, v.id)))).toBe('23001');
    });

    it('lists newest first, a page at a time, and searches name, number and email on the server', async () => {
      const marker = `PAGED${run}`;
      for (let i = 0; i < 4; i += 1) await vendor({ legalName: `${marker} ${String(i)}` });
      const first = await c.vendors.list(companyId, { q: marker, limit: 3 });
      expect(first.rows).toHaveLength(3);
      expect(first.next).not.toBeNull();
      const second = await c.vendors.list(companyId, { q: marker, limit: 3, before: first.next });
      expect(second.rows).toHaveLength(1);
      expect(second.next).toBeNull();
      const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
      expect(ids.size).toBe(4);
      expect((await c.vendors.list(companyId, { q: `nobody-${run}` })).rows).toHaveLength(0);
    });

    it('never shows one company another company’s vendor', async () => {
      const v = await vendor({}, true);
      const [other] = await db.insert(schema.companySettings).values({ legalName: 'O', tradingName: 'O', email: 'o@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P2' }).returning();
      expect(await c.vendors.get(required(other).id, v.id)).toBeNull();
      expect((await c.vendors.list(required(other).id, { q: 'Vendor' })).rows).toHaveLength(0);
    });
  });

  describe('portal links', () => {
    async function portalUser(vendorId: string, role: 'owner' | 'finance' = 'owner') {
      const [u] = await db.insert(schema.users).values({ email: `portal${randomUUID()}@example.test`, passwordHash: 'x', name: 'Portal', role: 'vendor' }).returning();
      await db.insert(schema.vendorUsers).values({ vendorId, userId: required(u).id, portalRole: role });
      return required(u);
    }

    it('a portal user finds its own vendor, and a removed one finds nothing', async () => {
      const { findPortalAccess } = await import('./portal-access');
      const v = await vendor({}, true);
      const u = await portalUser(v.id);
      expect(await findPortalAccess(u.id)).toEqual({ vendorId: v.id, portalRole: 'owner' });
      await db.update(schema.vendorUsers).set({ status: 'removed' }).where(eq(schema.vendorUsers.userId, u.id));
      expect(await findPortalAccess(u.id)).toBeNull();
    });

    it('an archived vendor loses portal access', async () => {
      const { findPortalAccess } = await import('./portal-access');
      const v = await vendor({}, true);
      const u = await portalUser(v.id);
      await db.update(schema.vendors).set({ status: 'archived' }).where(eq(schema.vendors.id, v.id));
      expect(await findPortalAccess(u.id)).toBeNull();
    });

    it('one login belongs to one vendor, and a vendor has one active owner', async () => {
      const a = await vendor({}, true);
      const b = await vendor({}, true);
      const u = await portalUser(a.id);
      expect(await codeOf(db.insert(schema.vendorUsers).values({ vendorId: b.id, userId: u.id, portalRole: 'finance' }))).toBe('23505');
      expect(await codeOf(portalUser(a.id, 'owner'))).toBe('23505');
      await portalUser(a.id, 'finance');
    });

    it('registering a business makes the business and its owner link together, and registers no number', async () => {
      const [u] = await db.insert(schema.users).values({ email: `reg${randomUUID()}@example.test`, passwordHash: 'x', name: 'New owner', role: 'vendor' }).returning();
      const id = await c.vendors.registerBusiness({ companyId, userId: required(u).id, legalName: `Self registered ${run}`, email: 'reg@example.test', phone: null });
      const found = required(await c.vendors.get(companyId, id));
      expect(found.vendor.status).toBe('registered');
      expect(found.vendor.number).toBeNull();
      expect(found.portalUsers).toHaveLength(1);
      expect(found.portalUsers[0]?.portal_role).toBe('owner');
      const view = required(await c.vendors.portalView(id));
      expect(Object.keys(view).sort()).toEqual(['block', 'legalName', 'number', 'status']);
    });
  });

  describe('the vendor ledger', () => {
    const ledger = () => c.finance.vendorLedger;
    const entry = (vendorId: string, over: Partial<Parameters<ReturnType<typeof ledger>['addEntry']>[1]> = {}) =>
      db.transaction((tx) => ledger().addEntry(tx, { companyId, vendorId, documentType: 'invoice', documentNo: `PI-${randomUUID().slice(0, 8)}`, amountCents: 100_000, currency: 'KES', postingDate: today, ...over }));

    it('an entry and its opening detailed entry are written together; the balance is what is open', async () => {
      const v = await vendor({}, true);
      await entry(v.id, { amountCents: 100_000 });
      await entry(v.id, { amountCents: 25_050 });
      await entry(v.id, { amountCents: 500, currency: 'USD' });
      expect(await ledger().balances(companyId, v.id)).toEqual([{ currency: 'KES', cents: 125_050 }, { currency: 'USD', cents: 500 }]);
      expect(await ledger().drift(companyId)).toEqual([]);
      const rows = await ledger().statement(companyId, v.id, null, null);
      expect(rows).toHaveLength(3);
    });

    it('a retried posting with the same key writes nothing more', async () => {
      const v = await vendor({}, true);
      const key = `test:${randomUUID()}`;
      const first = await entry(v.id, { idempotencyKey: key });
      const again = await entry(v.id, { idempotencyKey: key });
      expect(again).toEqual({ id: first.id, replayed: true });
      expect(await ledger().balances(companyId, v.id)).toEqual([{ currency: 'KES', cents: 100_000 }]);
    });

    it('the same vendor invoice number cannot be booked twice for one vendor, but another vendor may use it', async () => {
      const a = await vendor({}, true);
      const b = await vendor({}, true);
      await entry(a.id, { externalDocumentNo: 'INV 0042' });
      expect(await codeOf(entry(a.id, { externalDocumentNo: ' inv 0042 ' }))).toBe('23505');
      await entry(b.id, { externalDocumentNo: 'INV 0042' });
    });

    it('refuses a zero amount', async () => {
      const v = await vendor({}, true);
      expect(await codeOf(entry(v.id, { amountCents: 0 }))).toBe('AMOUNT_INVALID');
    });

    it('a posted entry cannot be changed or deleted, only what is open on it moves; detailed entries are append-only', async () => {
      const v = await vendor({}, true);
      const e = await entry(v.id);
      expect(await codeOf(db.update(schema.vendorLedgerEntries).set({ amount: '1.00' }).where(eq(schema.vendorLedgerEntries.id, e.id)))).toBe('23001');
      expect(await codeOf(db.update(schema.vendorLedgerEntries).set({ documentNo: 'X' }).where(eq(schema.vendorLedgerEntries.id, e.id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.vendorLedgerEntries).where(eq(schema.vendorLedgerEntries.id, e.id)))).toBe('23001');
      expect(await codeOf(db.update(schema.vendorDetailedEntries).set({ amount: '1.00' }).where(eq(schema.vendorDetailedEntries.ledgerEntryId, e.id)))).toBe('23001');
      expect(await codeOf(db.delete(schema.vendorDetailedEntries).where(eq(schema.vendorDetailedEntries.ledgerEntryId, e.id)))).toBe('23001');
      // The remaining amount may move (applications will do this), and the drift check then names the entry.
      await db.update(schema.vendorLedgerEntries).set({ remainingAmount: '0.00' }).where(eq(schema.vendorLedgerEntries.id, e.id));
      const drift = await ledger().drift(companyId);
      expect(drift.map((d) => d.id)).toContain(e.id);
      await db.execute(sql`ALTER TABLE vendor_detailed_entries DISABLE TRIGGER vendor_detailed_append_only`);
      try {
        await db.insert(schema.vendorDetailedEntries).values({ companyId, vendorId: v.id, ledgerEntryId: e.id, entryType: 'application', amount: '-1000.00', postingDate: today });
      } finally {
        await db.execute(sql`ALTER TABLE vendor_detailed_entries ENABLE TRIGGER vendor_detailed_append_only`);
      }
      expect((await ledger().drift(companyId)).map((d) => d.id)).not.toContain(e.id);
    });
  });
});
