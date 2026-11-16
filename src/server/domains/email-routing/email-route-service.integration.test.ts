import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';

/**
 * Who each business mail goes to, against a real database.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('email routing (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  const actor = { type: 'user' as const, id: 'email-routing-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const staff = async (name: string, over: Record<string, unknown> = {}) => {
    const [row] = await db.insert(schema.users).values({ email: `${name.toLowerCase().replace(/\W/g, '')}-${randomUUID().slice(0, 6)}@acme.test`, passwordHash: 'x', name, role: 'manager', ...over }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await db.update(schema.companySettings).set({ email: 'info@acme.test' }).where(eq(schema.companySettings.id, companyId));
    const { resolveSupportConfig } = await import('@/config/company-ui');
    await c.companySettings.setUiConfigSection('support', resolveSupportConfig({ name: 'Help', channels: [{ id: 'sales', kind: 'email', label: 'Sales desk', value: 'sales@acme.test', detail: '', url: '' }, { id: 'tel', kind: 'phone', label: 'Call', value: '0700 000 000', detail: '', url: '' }] }));
    await db.delete(schema.emailRoutes).where(eq(schema.emailRoutes.companyId, companyId));
  });

  // What is set up here must not leak into other tests that share the database: they expect the built-in behaviour.
  afterAll(async () => {
    await db.delete(schema.emailRoutes).where(eq(schema.emailRoutes.companyId, companyId));
  });

  it('shows every point with today\'s behaviour before anything is set up', async () => {
    const screen = await c.emailRoutes.screen(companyId);
    expect(screen.map((p) => p.key)).toContain('shop_quote_request_staff');
    const alert = screen.find((p) => p.key === 'shop_quote_request_staff');
    expect(alert).toMatchObject({ configured: false, enabled: true });
    expect(alert?.lists.to.map((s) => s.address)).toEqual(['info@acme.test']);
    expect(screen.find((p) => p.key === 'shop_order_placed_staff')?.enabled).toBe(false);
    expect(screen.find((p) => p.key === 'quote_sent')?.lists.replyTo[0]?.source.kind).toBe('company');
  });

  it('sends a web shop quote alert to several staff, copies the company and a channel, and answers to a typed address', async () => {
    const a = await staff('Wanjiru Kamau');
    const b = await staff('Otieno Odhiambo');
    await c.emailRoutes.save(companyId, 'shop_quote_request_staff', { enabled: true, to: [{ kind: 'staff', userId: a.id }, { kind: 'staff', userId: b.id }], cc: [{ kind: 'company' }], bcc: [{ kind: 'channel', channelId: 'sales' }], replyTo: [{ kind: 'address', address: 'help@acme.test' }, { kind: 'staff', userId: a.id }] }, actor, reason);
    const r = await c.emailRoutes.resolve(companyId, 'shop_quote_request_staff', { customerEmail: 'buyer@customer.test' });
    expect(r.send).toBe(true);
    expect(r.to).toEqual([a.email, b.email]);
    expect(r.cc).toEqual(['info@acme.test']);
    expect(r.bcc).toEqual(['sales@acme.test']);
    expect(r.replyTo).toEqual(['help@acme.test', a.email]);
    const screen = (await c.emailRoutes.screen(companyId)).find((p) => p.key === 'shop_quote_request_staff');
    expect(screen).toMatchObject({ configured: true, version: 1 });
    expect(screen?.lists.to.map((s) => s.label)).toEqual(['Wanjiru Kamau', 'Otieno Odhiambo']);
  });

  it('follows a change of a person\'s email, and leaves out someone who has been suspended, without stopping the mail', async () => {
    const a = await staff('Follow Me');
    const b = await staff('Gone Away');
    await c.emailRoutes.save(companyId, 'shop_order_paid_staff', { enabled: true, to: [{ kind: 'staff', userId: a.id }, { kind: 'staff', userId: b.id }] }, actor, reason);
    await db.update(schema.users).set({ email: `moved-${randomUUID().slice(0, 6)}@acme.test` }).where(eq(schema.users.id, a.id));
    await db.update(schema.users).set({ status: 'suspended' }).where(eq(schema.users.id, b.id));
    const moved = (await db.select().from(schema.users).where(eq(schema.users.id, a.id)))[0];
    const r = await c.emailRoutes.resolve(companyId, 'shop_order_paid_staff', { customerEmail: null });
    expect(r.to).toEqual([moved?.email]);
    expect(r.skipped).toHaveLength(1);
    const view = (await c.emailRoutes.screen(companyId)).find((p) => p.key === 'shop_order_paid_staff');
    expect(view?.lists.to[1]?.problem).toContain('no active account');
  });

  it('uses the staff member who sends it and the one who made the quote', async () => {
    const sender = await staff('The Sender');
    const maker = await staff('The Maker');
    await c.emailRoutes.save(companyId, 'quote_sent', { enabled: true, to: [{ kind: 'customer' }], cc: [{ kind: 'actor' }, { kind: 'owner' }], replyTo: [{ kind: 'owner' }] }, actor, reason);
    const r = await c.emailRoutes.resolve(companyId, 'quote_sent', { customerEmail: 'buyer@customer.test', actorUserId: sender.id, ownerUserId: maker.id });
    expect(r).toMatchObject({ to: ['buyer@customer.test'], cc: [sender.email, maker.email], replyTo: [maker.email] });
    const none = await c.emailRoutes.resolve(companyId, 'quote_sent', { customerEmail: 'buyer@customer.test' });
    expect(none.cc).toEqual([]);
  });

  it('refuses what cannot work, each in words, and keeps what was saved before', async () => {
    const before = (await c.emailRoutes.screen(companyId)).find((p) => p.key === 'shop_quote_request_staff');
    const say = async (point: unknown, raw: unknown, why: unknown = reason) => await c.emailRoutes.save(companyId, point, raw, actor, why as never).then(() => 'saved', (e: unknown) => (e instanceof Error ? e.message : 'failed'));
    expect(await say('nonsense', { to: [{ kind: 'company' }] })).toBe('That email is not one that can be set up.');
    expect(await say('shop_quote_request_staff', { enabled: true, to: [] })).toBe('Choose who it is sent to, or switch it off.');
    expect(await say('shop_quote_request_staff', { to: [{ kind: 'staff', userId: randomUUID() }] })).toContain('no active account');
    expect(await say('shop_quote_request_staff', { to: [{ kind: 'channel', channelId: 'tel' }] })).toContain('not an email channel');
    expect(await say('shop_quote_request_staff', { to: [{ kind: 'address', address: 'nope' }] })).toBe('That address does not look right: nope');
    expect(await say('shop_quote_request_staff', { to: [{ kind: 'company' }] }, { code: 'NO_SUCH_REASON' })).not.toBe('saved');
    const after = (await c.emailRoutes.screen(companyId)).find((p) => p.key === 'shop_quote_request_staff');
    expect(after?.version).toBe(before?.version);
  });

  it('can switch a mail off, keeps the document points to their own list, and goes back to the built-in behaviour on reset', async () => {
    await c.emailRoutes.save(companyId, 'shop_order_placed_customer', { enabled: false }, actor, reason);
    expect(await c.emailRoutes.resolve(companyId, 'shop_order_placed_customer', { customerEmail: 'b@c.test' })).toMatchObject({ send: false, reason: 'This email is switched off.' });
    await c.emailRoutes.save(companyId, 'quote_document_shop', { shown: [{ kind: 'channel', channelId: 'sales' }, { kind: 'company' }], to: [{ kind: 'customer' }] }, actor, reason);
    const doc = await c.emailRoutes.resolve(companyId, 'quote_document_shop', { customerEmail: null });
    expect(doc.shown).toEqual(['sales@acme.test', 'info@acme.test']);
    expect(doc.to).toEqual([]);
    await c.emailRoutes.reset(companyId, 'shop_order_placed_customer', actor, reason);
    expect((await c.emailRoutes.resolve(companyId, 'shop_order_placed_customer', { customerEmail: 'b@c.test' })).to).toEqual(['b@c.test']);
  });

  it('records each change in the decision log', async () => {
    const entries = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectType, 'email_route'));
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['email_routing.configured', 'email_routing.reset']));
  });

  it('offers only active staff to choose from, never customers, and only email channels', async () => {
    const { EMAIL_ROUTING_LOOKUP_SOURCES } = await import('./lookup-sources');
    const find = (key: string) => EMAIL_ROUTING_LOOKUP_SOURCES.find((s) => s.key === key);
    const customer = await staff('Just A Customer', { role: 'customer' });
    const picked = await find('email-routing-staff')?.search({ companyId, query: 'Just A Customer', limit: 20, after: null, filters: {} });
    expect(picked?.options.map((o) => o.id)).not.toContain(customer.id);
    const channels = await find('email-routing-channels')?.search({ companyId, query: '', limit: 20, after: null, filters: {} });
    expect(channels?.options.map((o) => o.id)).toEqual(['sales']);
  });
});
