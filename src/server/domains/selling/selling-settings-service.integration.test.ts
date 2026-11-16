import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import { defOf } from './selling-documents';

/**
 * How each selling document type behaves for the company, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('selling document settings (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  const actor = { type: 'user' as const, id: 'selling-settings-test' };
  const reason = { code: 'POLICY_CHANGE' };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await db.delete(schema.sellingDocumentSettings).where(eq(schema.sellingDocumentSettings.companyId, companyId));
  });

  // What is set here must not leak into other tests that share the database.
  afterAll(async () => {
    await db.delete(schema.sellingDocumentSettings).where(eq(schema.sellingDocumentSettings.companyId, companyId));
  });

  it('behaves by the built-in defaults until something is changed', async () => {
    expect(await c.sellingSettings.get(companyId, 'sales_invoice')).toEqual(defOf('sales_invoice').defaults);
    const screen = await c.sellingSettings.screen(companyId);
    expect(screen.map((t) => t.type).sort()).toEqual(['credit_sale', 'pos_cash_sale', 'sales_invoice', 'sales_order']);
    expect(screen.every((t) => !t.configured && t.version === 0)).toBe(true);
  });

  it('keeps a change for one type only, and "always hold until paid" is a choice of stock release', async () => {
    const mine = { ...defOf('sales_invoice').defaults, stockRelease: 'on_payment' as const, creditCheck: 'limit_and_overdue' as const, overdueDays: 14 };
    await c.sellingSettings.save(companyId, 'sales_invoice', mine, actor, reason);
    expect(await c.sellingSettings.get(companyId, 'sales_invoice')).toMatchObject({ stockRelease: 'on_payment', creditCheck: 'limit_and_overdue', overdueDays: 14 });
    expect(await c.sellingSettings.get(companyId, 'sales_order')).toEqual(defOf('sales_order').defaults);
    const view = (await c.sellingSettings.screen(companyId)).find((t) => t.type === 'sales_invoice');
    expect(view).toMatchObject({ configured: true, version: 1 });
    await c.sellingSettings.save(companyId, 'sales_invoice', { ...mine, fixedDays: 45, creditDays: 'fixed' }, actor, reason);
    expect((await c.sellingSettings.screen(companyId)).find((t) => t.type === 'sales_invoice')).toMatchObject({ version: 2 });
  });

  it('refuses what cannot work, each in words, and keeps what was saved before', async () => {
    const say = async (type: unknown, raw: unknown, why: unknown = reason) => await c.sellingSettings.save(companyId, type, raw, actor, why as never).then(() => 'saved', (e: unknown) => (e instanceof Error ? e.message : 'failed'));
    const before = (await c.sellingSettings.screen(companyId)).find((t) => t.type === 'sales_invoice');
    expect(await say('ecommerce', defOf('sales_order').defaults)).toBe('That is not a selling document that can be set up.');
    expect(await say('pos_cash_sale', { ...defOf('pos_cash_sale').defaults, creditCheck: 'limit' })).toBe('Choose the credit check.');
    expect(await say('sales_order', { ...defOf('sales_order').defaults, fixedDays: 999 })).toContain('whole number from 0 to 365');
    expect(await say('sales_order', defOf('sales_order').defaults, { code: 'NO_SUCH_REASON' })).not.toBe('saved');
    expect((await c.sellingSettings.screen(companyId)).find((t) => t.type === 'sales_invoice')?.version).toBe(before?.version);
  });

  it('puts a type back to its built-in behaviour and records every change with who and why', async () => {
    await c.sellingSettings.reset(companyId, 'sales_invoice', actor, reason);
    expect(await c.sellingSettings.get(companyId, 'sales_invoice')).toEqual(defOf('sales_invoice').defaults);
    const entries = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectType, 'selling_document'));
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['selling.configured', 'selling.changed', 'selling.reset']));
  });

  it('reads a damaged row as the defaults instead of failing a sale', async () => {
    await db.insert(schema.sellingDocumentSettings).values({ companyId, docType: 'sales_order', config: { creditCheck: 'garbage', stockRelease: 42 }, version: 1, updatedBy: 'test' });
    expect(await c.sellingSettings.get(companyId, 'sales_order')).toEqual(defOf('sales_order').defaults);
  });

  it('offers only the choices a type allows, to the settings screen\'s pickers, and refuses other filters', async () => {
    const { SELLING_LOOKUP_SOURCES } = await import('./lookup-sources');
    const source = SELLING_LOOKUP_SOURCES[0];
    const ask = async (filters: Record<string, string>) => await source?.search({ companyId, query: '', limit: 20, after: null, filters });
    expect((await ask({ setting: 'creditCheck', type: 'sales_order' }))?.options.map((o) => o.id)).toEqual(['limit', 'limit_and_overdue', 'off']);
    expect((await ask({ setting: 'creditCheck', type: 'pos_cash_sale' }))?.options.map((o) => o.id)).toEqual(['off']);
    await expect(ask({ setting: 'creditCheck', type: 'nope' })).rejects.toThrow();
    await expect(ask({})).rejects.toThrow();
  });

  it('lets a new stock location serve sales invoices as it serves sales orders', async () => {
    const [loc] = await db.insert(schema.stockLocations).values({ companyId, code: `S0-${Date.now()}`, name: 'Selling test', kind: 'store' }).returning();
    expect(loc?.sellsChannels).toContain('sales_invoice');
    if (loc !== undefined) await db.delete(schema.stockLocations).where(eq(schema.stockLocations.id, loc.id));
  });
});
