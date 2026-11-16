import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { SmsAccounts as SmsAccountsType } from './accounts';

vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

/**
 * The SMS provider connections, against a real database: the first is the default, keys are sealed and never come back, a change keeps
 * the key unless a new one is typed, one default at a time, a test message with a fixed text, and nothing across companies.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('SMS provider accounts (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let SmsAccounts: typeof SmsAccountsType;
  let companyId: string;
  let now = new Date('2026-11-12T10:00:00Z');
  const sent: { url: string; key: string; body: URLSearchParams }[] = [];
  let providerAnswer: () => Response = () => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 101, messageId: 'ATXid_9' }] } }), { status: 201 });
  const fetchFn = (u: string, init: RequestInit) => {
    sent.push({ url: u, key: (init.headers as Record<string, string>).apiKey ?? '', body: new URLSearchParams(init.body as string) });
    return Promise.resolve(providerAnswer());
  };
  let svc: InstanceType<typeof SmsAccountsType>;
  const actor = () => ({ companyId, userId: 'admin-1' });
  const KEY = 'live-key-ABCDEFGHIJKLMNOP-12345';
  const at = (over: Record<string, unknown> = {}) => ({ name: `Shop SMS ${randomUUID().slice(0, 6)}`, adapter: 'africastalking', username: 'yourshop', apiKey: KEY, senderId: 'YOURSHOP', ...over });
  const must = async <T,>(p: Promise<{ ok: true; data: T } | { ok: false; message: string }>): Promise<T> => {
    const r = await p;
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    c = (await import('@/server/di/container')).getContainer();
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ SmsAccounts } = await import('./accounts'));
    companyId = (await c.companySettings.ensureSeeded()).id;
    svc = new SmsAccounts(db, c.decisionLog, fetchFn, () => now);
  }, 120_000);
  beforeEach(async () => {
    sent.length = 0;
    now = new Date(now.getTime() + 3600_000);
    providerAnswer = () => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 101, messageId: 'ATXid_9' }] } }), { status: 201 });
    await db.delete(schema.smsProviderAccounts).where(eq(schema.smsProviderAccounts.companyId, companyId));
  });
  afterAll(async () => {
    await db.delete(schema.smsProviderAccounts).where(eq(schema.smsProviderAccounts.companyId, companyId));
  });

  it('makes the first connection the default, and keeps the key sealed: it is not in the row, the view or the decision log', async () => {
    const first = await must(svc.create(actor(), at()));
    const second = await must(svc.create(actor(), at({ name: 'Second' })));
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(first.values).toEqual({ username: 'yourshop', senderId: 'YOURSHOP' });
    expect(first.secretsKept).toEqual(['apiKey']);
    expect(JSON.stringify(first)).not.toContain(KEY);
    const [row] = await db.select().from(schema.smsProviderAccounts).where(eq(schema.smsProviderAccounts.id, first.id));
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(row?.secretsSealed).not.toBeNull();
    const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectType, 'sms_provider_account'), eq(schema.decisionLog.subjectId, first.id)));
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain(KEY);
  });

  it('refuses a missing provider, a missing key, a bad sender name and a name already used, in any letter case', async () => {
    expect(await svc.create(actor(), at({ adapter: 'nexmo' }))).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await svc.create(actor(), at({ apiKey: '' }))).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('API key') as string });
    expect(await svc.create(actor(), at({ senderId: 'two words' }))).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await svc.create(actor(), at({ name: 'x' }))).toMatchObject({ ok: false, reason: 'bad_input' });
    await must(svc.create(actor(), at({ name: 'Main Shop' })));
    expect(await svc.create(actor(), at({ name: 'main SHOP' }))).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('keeps the saved key when the key box is left empty, replaces it when a new one is typed, and clears the old test result when credentials change', async () => {
    const made = await must(svc.create(actor(), at()));
    await must(svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' }));
    const renamed = await must(svc.update(actor(), made.id, { name: 'Renamed', username: 'yourshop', apiKey: '', senderId: 'YOURSHOP', expectedVersion: made.version }));
    expect(renamed.name).toBe('Renamed');
    expect(renamed.lastTest).not.toBeNull();
    sent.length = 0;
    now = new Date(now.getTime() + 60_000);
    await must(svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' }));
    expect(sent[0]?.key).toBe(KEY);
    const rekeyed = await must(svc.update(actor(), made.id, { apiKey: 'new-key-ZZZZZZZZZZZZZZZZZZZZ-1', expectedVersion: renamed.version }));
    expect(rekeyed.lastTest).toBeNull();
    now = new Date(now.getTime() + 60_000);
    sent.length = 0;
    await must(svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' }));
    expect(sent[0]?.key).toBe('new-key-ZZZZZZZZZZZZZZZZZZZZ-1');
    expect(await svc.update(actor(), made.id, { name: 'Stale', expectedVersion: made.version })).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('has one default at a time, never a stopped one, and no sender when the default is stopped', async () => {
    const a = await must(svc.create(actor(), at({ name: 'Alpha' })));
    const b = await must(svc.create(actor(), at({ name: 'Beta' })));
    expect(await svc.defaultSender(companyId)).not.toBeNull();
    const madeB = await must(svc.setDefault(actor(), b.id));
    expect(madeB.isDefault).toBe(true);
    const listed = await svc.list(companyId);
    expect(listed.filter((x) => x.isDefault).map((x) => x.name)).toEqual(['Beta']);
    expect(await svc.setDefault(actor(), a.id, 1)).toMatchObject({ ok: false, reason: 'conflict' });
    const stoppedB = await must(svc.setActive(actor(), b.id, false));
    expect(stoppedB).toMatchObject({ isActive: false, isDefault: false });
    expect(await svc.defaultSender(companyId)).toBeNull();
    expect(await svc.setDefault(actor(), b.id)).toMatchObject({ ok: false, reason: 'not_allowed' });
    const aNow = (await svc.list(companyId)).find((x) => x.name === 'Alpha');
    await must(svc.setDefault(actor(), a.id, aNow?.version));
    expect(await svc.defaultSender(companyId)).not.toBeNull();
  });

  it('never ends with two defaults when connections are added at the same moment', async () => {
    await Promise.all([svc.create(actor(), at({ name: 'P1' })), svc.create(actor(), at({ name: 'P2' })), svc.create(actor(), at({ name: 'P3' }))]);
    expect((await svc.list(companyId)).filter((x) => x.isDefault)).toHaveLength(1);
  });

  it('sends the fixed test text to the number typed, written with the country code, and keeps neither the number nor the words', async () => {
    const made = await must(svc.create(actor(), at()));
    const tested = await must(svc.sendTest(actor(), made.id, { to: '0712 345 678', shopName: 'Wanjiku Traders' }));
    expect(tested.lastTest).toMatchObject({ ok: true, error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.get('to')).toBe('+254712345678');
    expect(sent[0]?.body.get('message')).toBe('Test message from Wanjiku Traders: your SMS provider is connected.');
    expect(sent[0]?.url).toBe('https://api.africastalking.com/version1/messaging');
    const [row] = await db.select().from(schema.smsProviderAccounts).where(eq(schema.smsProviderAccounts.id, made.id));
    expect(JSON.stringify(row)).not.toContain('712345678');
    const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, made.id), eq(schema.decisionLog.action, 'sms.test_sent')));
    expect(JSON.stringify(log)).not.toContain('712345678');
  });

  it('refuses a number that is not a mobile number, a test a moment after another, and a stopped connection', async () => {
    const made = await must(svc.create(actor(), at()));
    expect(await svc.sendTest(actor(), made.id, { to: 'abc', shopName: 'Shop' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(sent).toHaveLength(0);
    await must(svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' }));
    expect(await svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' })).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('a moment ago') as string });
    expect(sent).toHaveLength(1);
    now = new Date(now.getTime() + 31_000);
    await must(svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' }));
    expect(sent).toHaveLength(2);
    await must(svc.setActive(actor(), made.id, false));
    now = new Date(now.getTime() + 60_000);
    expect(await svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('keeps the provider\'s refusal as plain words, with nothing of the provider\'s own text', async () => {
    const made = await must(svc.create(actor(), at()));
    providerAnswer = () => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 405, status: 'PROVIDER-INTERNAL-TEXT' }] } }), { status: 201 });
    const tested = await must(svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' }));
    expect(tested.lastTest?.ok).toBe(false);
    expect(tested.lastTest?.error).toContain('balance');
    expect(JSON.stringify(tested)).not.toContain('PROVIDER-INTERNAL-TEXT');
  });

  it('trials the log provider without any key, and sends nothing out', async () => {
    const made = await must(svc.create(actor(), { name: 'Trial', adapter: 'log' }));
    expect(made.secretsKept).toEqual([]);
    const tested = await must(svc.sendTest(actor(), made.id, { to: '0712345678', shopName: 'Shop' }));
    expect(tested.lastTest?.ok).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('shows and changes only this company\'s connections', async () => {
    const made = await must(svc.create(actor(), at()));
    const other = { companyId: randomUUID(), userId: 'someone' };
    expect(await svc.list(other.companyId)).toEqual([]);
    expect(await svc.update(other, made.id, { name: 'Taken over' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await svc.setActive(other, made.id, false)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await svc.setDefault(other, made.id)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await svc.sendTest(other, made.id, { to: '0712345678', shopName: 'Shop' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await svc.update(actor(), 'not-an-id', { name: 'x' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await svc.defaultSender(other.companyId)).toBeNull();
  });
});
