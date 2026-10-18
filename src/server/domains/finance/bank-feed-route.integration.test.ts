import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has } from '@/lib/values';
import { refundKit } from './refund-test-kit';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
describe.skipIf(!has(process.env.TEST_DATABASE_URL))('the bank feed address (database)', () => {
  const k = refundKit('FEEDAPI');

  async function account() {
    return await k.fin.bankAccounts.create(k.ctx, { code: `FD${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Feed account', kind: 'bank', currency: 'KES' });
  }
  const call = async (accountId: string, secret: string, body: string | object, headers: Record<string, string> = {}) => {
    const { POST } = await import('../../../../app/api/hooks/bank-feed/[accountId]/[secret]/route');
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await POST(new Request('http://localhost/api/hooks/bank-feed/x/y', { method: 'POST', body: text, headers: { 'content-type': 'application/json', ...headers } }), { params: Promise.resolve({ accountId, secret }) });
    return { status: res.status, cacheControl: res.headers.get('cache-control'), json: (await res.json()) as Record<string, unknown> };
  };
  const line = { date: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }), amount: '250.00', reference: 'BANK-REF-1', description: 'Deposit' };

  it('takes a good delivery, says what it did, and is never cached', async () => {
    const a = await account();
    const { secret } = await k.fin.bankFeeds.enable(k.ctx, a.id);
    const ok = await call(a.id, secret, { lines: [line] }, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
    expect(ok).toMatchObject({ status: 200, cacheControl: 'no-store', json: { ok: true, lines: 1, duplicates: 0 } });
    const again = await call(a.id, secret, { lines: [line] });
    expect(again).toMatchObject({ status: 200, json: { ok: true, lines: 0, duplicates: 1 } });
    const [imp] = await k.db.select().from(k.schema.bankStatementImports).where(eq(k.schema.bankStatementImports.bankAccountId, a.id));
    expect(imp.format).toBe('feed');
    const decisions = await k.db.select().from(k.schema.decisionLog).where(eq(k.schema.decisionLog.subjectId, imp.id));
    expect(decisions[0]).toMatchObject({ actorType: 'integration' });
  });

  it('answers every wrong secret the same way, and says nothing about why', async () => {
    const a = await account();
    const { secret } = await k.fin.bankFeeds.enable(k.ctx, a.id);
    for (const wrong of ['nope', `${secret}0`, secret.slice(1)]) {
      expect(await call(a.id, wrong, { lines: [line] })).toMatchObject({ status: 404, json: { ok: false, error: 'Not found.' } });
    }
    expect(await call(randomUUID(), secret, { lines: [line] })).toMatchObject({ status: 404 });
  });

  it('refuses a body that is not JSON, not a list of lines, or too large, with a reason', async () => {
    const a = await account();
    const { secret } = await k.fin.bankFeeds.enable(k.ctx, a.id);
    expect(await call(a.id, secret, 'this is not json')).toMatchObject({ status: 400, json: { ok: false } });
    expect(await call(a.id, secret, { nothing: true })).toMatchObject({ status: 400 });
    expect(await call(a.id, secret, { lines: [{ date: 'x', amount: '1' }] })).toMatchObject({ status: 400 });
    expect(await call(a.id, secret, { lines: [line] }, { 'content-length': String(6 * 1024 * 1024) })).toMatchObject({ status: 413 });
    expect(await call(a.id, secret, `{"lines":[],"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`)).toMatchObject({ status: 413 });
  });
});
