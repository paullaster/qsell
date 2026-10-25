import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';

import { has, nth, readText, required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { FinanceServices } from '@/server/domains/finance';
import type { PaymentService } from '../service';
import type { PaymentEngine } from './payment-engine';
import type { BranchRow } from '@/server/db/drizzle/schema';

/**
 * The payment engine against a stand-in for Safaricom (and Pesapal). A payment is counted only when the
 * platform itself confirms it; everything else is refused with a reason.   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;

interface Reply { status?: number; json?: Record<string, unknown> | null; text?: string }
type Handler = (body: Record<string, unknown>, url: URL) => Reply | Promise<Reply>;

class FakePlatform {
  calls: { method: string; path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  handlers = new Map<string, Handler>();
  down = false;
  on(path: string, h: Handler) {
    this.handlers.set(path, h);
  }
  count(path: string) {
    return this.calls.filter((c) => c.path === path).length;
  }
  fetch: typeof fetch = async (input, init) => {
    const u = new URL(readText(input));
    // A form body (the KCB token call) is not JSON: it has nothing for a handler to read.
    const body = init?.body === undefined || init.body === null ? {} : (() => { try { return JSON.parse(readText(init.body)) as Record<string, unknown>; } catch { return {}; } })();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    this.calls.push({ method: init?.method ?? 'GET', path: u.pathname, body, headers });
    if (this.down) throw new Error('connect ECONNREFUSED');
    const h = this.handlers.get(u.pathname) ?? [...this.handlers].find(([k]) => k.endsWith('*') && u.pathname.startsWith(k.slice(0, -1)))?.[1];
    const r = h ? await h(body, u) : { status: 404, json: { errorCode: '404.001.01', errorMessage: `No handler for ${u.pathname}` } };
    const text = r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json));
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
}

describe.skipIf(!has(url))('payment engine (database)', () => {
  type Db = DrizzleDb;
  let db: Db;
  let schema: typeof mod_server_db_drizzle_schema;
  let fin: FinanceServices;
  let payments: PaymentService;
  let engine: PaymentEngine;
  let fake: FakePlatform;
  let companyId: string;
  let branch: BranchRow;
  let glMobile: string;
  let bankId: string;
  let certificate: string;
  let jengaKey: string;
  const jobCalls: [string, string, number | undefined][] = [];
  const run = randomUUID().slice(0, 6).toUpperCase();
  let seq = 0;
  const rc = () => `${run}${String(++seq).padStart(4, '0')}`.slice(0, 10);
  const ctx = () => ({ companyId, actor: { type: 'user' as const, id: 'tester' }, origin: { surface: 'test', action: 'run' } });

  const credentialsFor = (code: string, initiator: boolean): Record<string, string> => {
    if (code === 'mpesa_daraja') return { consumerKey: 'ck', consumerSecret: 'cs', shortcode: '174379', passkey: 'pk-secret-value', ...(initiator ? { initiatorName: 'apiuser', initiatorPassword: 'Init#Pass1', certificate } : {}) };
    if (code === 'pesapal_v3') return { consumerKey: 'ck', consumerSecret: 'cs' };
    if (code === 'kcb_buni') return { consumerKey: 'ck', consumerSecret: 'cs', orgShortCode: '174379' };
    return { merchantCode: 'm', consumerSecret: 's', apiKey: 'k', privateKeyPem: jengaKey };
  };

  async function provider(opts: { code?: 'mpesa_daraja' | 'pesapal_v3' | 'jenga_hq' | 'kcb_buni'; settings?: Record<string, unknown>; initiator?: boolean; channel?: string; autoAllocate?: boolean } = {}) {
    const code = opts.code ?? 'mpesa_daraja';
    // One method serves a branch's checkout for a service at a time (the first by sort order): earlier ones are stood down.
    await db.update(schema.paymentMethods).set({ enabled: false }).where(and(eq(schema.paymentMethods.companyId, companyId), eq(schema.paymentMethods.branchId, branch.id)));
    const { id } = await fin.paymentProviders.create(ctx(), { providerCode: code, displayName: `${code} ${run} ${++seq}` });
    await fin.paymentProviders.setCredentials(ctx(), id, credentialsFor(code, opts.initiator === true));
    const settings = { ...(opts.settings ?? {}), ...(opts.autoAllocate === true ? { c2b: { autoAllocate: 'by_customer_number' } } : {}) };
    await db.update(schema.paymentProviderConfigs).set({ isEnabled: true, lastTestOk: true, settings, apiBaseUrl: 'https://sandbox.safaricom.co.ke' }).where(eq(schema.paymentProviderConfigs.id, id));
    const m = await fin.paymentMethods.create(ctx(), { code: `PE${run}${++seq}`, name: `Method ${seq}`, kind: 'mobile_money', balancingBankAccountId: bankId, providerId: id, glAccountId: glMobile, branchId: branch.id, channelKind: 'paybill', channelNumber: opts.channel ?? '174379', requiresReference: false });
    return { providerId: id, methodId: m.id };
  }
  const setSettings = (providerId: string, settings: Record<string, unknown>) => db.update(schema.paymentProviderConfigs).set({ settings }).where(eq(schema.paymentProviderConfigs.id, providerId));

  const stkOk = () => {
    let n = 0;
    fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
    fake.on('/mpesa/stkpush/v1/processrequest', () => ({ json: { MerchantRequestID: `M-${run}-${++n}-${seq}`, CheckoutRequestID: `ws_CO_${run}_${++seq}`, ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'Success. Request accepted for processing' } }));
  };

  async function startPayment(p: { providerId: string }, o: { amount?: number; phone?: string; code?: 'mpesa_daraja' | 'pesapal_v3' | 'jenga_hq' | 'kcb_buni' } = {}) {
    seq += 1;
    const id = `pe_${run}_${seq}`;
    const number = `PE-${run}-${seq}`;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, payment_status)
      VALUES (${id}, ${number}, 'u', ${branch.id}::uuid, 'n', 'e@x.io', '0712345678', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, ${(o.amount ?? 100) / 1.16}, ${(o.amount ?? 100) - (o.amount ?? 100) / 1.16}, 0, ${o.amount ?? 100}, ${o.code ?? 'mpesa_daraja'}, 'pending')`);
    const out = await payments.initiatePayment({ branch, providerCode: o.code ?? 'mpesa_daraja', orderId: id, orderNumber: number, amount: o.amount ?? 100, currency: 'KES', customerName: 'n', customerEmail: 'e@x.io', customerPhone: o.phone ?? '0712345678' });
    return { attempt: out.attempt, orderId: id, number };
  }
  const reload = async (id: string) => (await db.select().from(schema.paymentAttempts).where(eq(schema.paymentAttempts.id, id)))[0];
  const order = async (id: string) => (await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];
  const stkBody = (a: { providerReference: string | null; externalReference: string | null }, o: { code?: number; amount?: number; phone?: number | string; receipt?: string } = {}) => ({
    Body: { stkCallback: { MerchantRequestID: a.externalReference, CheckoutRequestID: a.providerReference, ResultCode: o.code ?? 0, ResultDesc: (o.code ?? 0) === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
      ...((o.code ?? 0) === 0 ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: o.amount ?? 100 }, { Name: 'MpesaReceiptNumber', Value: o.receipt ?? rc() }, { Name: 'TransactionDate', Value: 20260113123045 }, { Name: 'PhoneNumber', Value: o.phone ?? 254712345678 }] } } : {}) } },
  });
  const callback = (a: { callbackToken: string }, body: unknown, ip = '196.201.214.200') => engine.ingestAttemptCallback({ token: a.callbackToken, rawText: JSON.stringify(body), headers: { 'content-type': 'application/json' }, sourceIp: ip, https: true, method: 'POST' });
  const stkQuery = (resultCode: number | string | null, extra: Record<string, unknown> = {}) =>
    fake.on('/mpesa/stkpushquery/v1/query', (b) => ({ json: resultCode === null ? { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } : { ResponseCode: '0', ResponseDescription: 'ok', MerchantRequestID: 'x', CheckoutRequestID: String(b.CheckoutRequestID), ResultCode: String(resultCode), ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user', ...extra }, status: resultCode === null ? 500 : 200 }));
  const events = (attemptId: string) => db.select().from(schema.providerEvents).where(eq(schema.providerEvents.attemptId, attemptId)).orderBy(desc(schema.providerEvents.createdAt));

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const { createPaymentEngine } = await import('./index');
    const { PaymentRegistry } = await import('../registry');
    const { FinanceC2bConsumer } = await import('@/server/domains/finance/receivables/c2b-consumer');
    const c = getContainer();
    fin = c.finance;
    payments = c.payments;
    fake = new FakePlatform();
    // The platform adapters use the global fetch; none of them may reach the real internet in a test.
    vi.stubGlobal('fetch', fake.fetch);
    engine = createPaymentEngine({
      db,
      registry: new PaymentRegistry(),
      payments,
      consumer: new FinanceC2bConsumer(db, fin.receipts),
      fetchImpl: fake.fetch,
      jobs: {
        verifyAttempt: (id, s) => Promise.resolve(void jobCalls.push(['attempt', id, s])),
        verifyTransaction: (id, s) => Promise.resolve(void jobCalls.push(['transaction', id, s])),
        processEvent: (id) => Promise.resolve(void jobCalls.push(['event', id, 0])),
        sendOperation: (id, s) => Promise.resolve(void jobCalls.push(['send', id, s])),
      },
    });
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    jengaKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    certificate = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'PE', tradingName: 'PE', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P', publicBaseUrl: 'https://shop.example' }).returning();
    companyId = company.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await fin.setup.applyTemplate(ctx(), 'kenya', { fiscalYearStart: '2026-01-01' });
    const accts = await fin.setup.listAccounts(companyId);
    glMobile = required(accts.find((a) => a.no === '1125')).id;
    bankId = (await fin.bankAccounts.create(ctx(), { code: `PEB${run}`, name: 'Engine M-Pesa', kind: 'mobile_money', currency: 'KES' })).id;
    branch = nth((await db.insert(schema.branches).values({ companyId, code: `PEBR${run}`, name: 'Engine branch', isDefault: false }).returning()), 0);
    stkOk();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe('M-Pesa Express: a payment is counted only when Safaricom confirms it', () => {
    it('a good callback is checked with Safaricom, then the order is paid, once, and everything is logged', async () => {
      const p = await provider();
      const { attempt, orderId } = await startPayment(p);
      expect(attempt.status).toBe('pending');
      expect(attempt.callbackUrl).toMatch(/\/api\/hooks\/pay\/attempt\/[A-Za-z0-9_-]{43}$/);
      expect(jobCalls.some((j) => j[0] === 'attempt' && j[1] === attempt.id && j[2] === 15)).toBe(true);
      const op = (await engine.ops.bySubject('payment_attempt', attempt.id, 'stk_push'))[0];
      expect(op).toMatchObject({ status: 'accepted', methodId: p.methodId });

      stkQuery(0);
      const reply = await callback(attempt, stkBody(attempt));
      expect(reply).toMatchObject({ httpStatus: 200, body: { ResultCode: 0 } });
      // nothing is counted just because the callback arrived
      expect((await reload(attempt.id)).status).toBe('pending');
      expect((await order(orderId)).paymentStatus).not.toBe('paid');
      const verdict = await engine.verification.verifyAttempt(attempt.id);
      expect(verdict.outcome).toBe('confirmed');
      expect((await reload(attempt.id)).status).toBe('successful');
      expect((await order(orderId)).paymentStatus).toBe('paid');
      const tx = (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, attempt.id)))[0];
      expect(tx).toMatchObject({ state: 'consumed', consumedType: 'payment_attempt', verifiedBy: 'stk_query', kind: 'gateway', amount: '100.0000' });
      expect(JSON.stringify(tx.evidence)).toContain('stkQuery');
      expect((await events(attempt.id))[0]).toMatchObject({ state: 'consumed', kind: 'stk_callback', sourceIp: '196.201.214.200' });
      // it is not counted twice
      expect((await engine.verification.verifyAttempt(attempt.id)).outcome).toBe('already_final');
      // what was sent and received is on record, without secrets or phone numbers
      const log = await db.select().from(schema.integrationAuditLog).where(eq(schema.integrationAuditLog.providerId, p.providerId));
      const text = JSON.stringify(log);
      expect(log.map((l) => l.operation)).toEqual(expect.arrayContaining(['oauth', 'stk_push', 'stk_query']));
      expect(text).not.toContain('pk-secret-value');
      expect(text).not.toContain('Bearer tok');
      expect(text).not.toContain('254712345678');
    });

    it('a callback for the wrong amount or another payer is refused without asking Safaricom to settle it', async () => {
      const p = await provider();
      stkQuery(0);
      const a = await startPayment(p, { amount: 500 });
      await callback(a.attempt, stkBody(a.attempt, { amount: 5 }));
      const before = fake.count('/mpesa/stkpushquery/v1/query');
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('mismatch');
      expect(fake.count('/mpesa/stkpushquery/v1/query')).toBe(before);
      expect((await events(a.attempt.id))[0]).toMatchObject({ state: 'mismatch', failureCode: 'AMOUNT_MISMATCH' });
      expect((await order(a.orderId)).paymentStatus).not.toBe('paid');
      const b = await startPayment(p);
      await callback(b.attempt, stkBody(b.attempt, { phone: 254799999999 }));
      expect((await engine.verification.verifyAttempt(b.attempt.id)).outcome).toBe('mismatch');
      expect((await events(b.attempt.id))[0].failureCode).toBe('PAYER_MISMATCH');
      const c = await startPayment(p);
      await callback(c.attempt, stkBody({ providerReference: 'ws_CO_FORGED', externalReference: c.attempt.externalReference }));
      expect((await engine.verification.verifyAttempt(c.attempt.id)).outcome).toBe('mismatch');
      expect((await events(c.attempt.id))[0].failureCode).toBe('CHECKOUT_ID_MISMATCH');
      const d = await startPayment(p);
      await callback(d.attempt, stkBody(d.attempt, { receipt: 'forged' }));
      expect((await engine.verification.verifyAttempt(d.attempt.id)).outcome).toBe('mismatch');
      expect((await events(d.attempt.id))[0].failureCode).toBe('RECEIPT_FORMAT');
    });

    it('a callback that says paid is overruled when Safaricom says the customer cancelled', async () => {
      const p = await provider();
      const a = await startPayment(p);
      await callback(a.attempt, stkBody(a.attempt));
      stkQuery(1032);
      const v = await engine.verification.verifyAttempt(a.attempt.id);
      expect(v.outcome).toBe('failed');
      expect((await reload(a.attempt.id)).status).toBe('failed');
      expect((await order(a.orderId)).paymentStatus).toBe('failed');
      expect((await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, a.attempt.id))).length).toBe(0);
    });

    it('a callback that says failed is overruled when Safaricom says it succeeded', async () => {
      const p = await provider();
      const a = await startPayment(p);
      await callback(a.attempt, stkBody(a.attempt, { code: 1032 }));
      stkQuery(0);
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('confirmed');
      expect((await order(a.orderId)).paymentStatus).toBe('paid');
    });

    it('with no callback at all, the check alone settles it (and the reference falls back to the checkout id)', async () => {
      const p = await provider();
      const a = await startPayment(p);
      stkQuery(0);
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('confirmed');
      const tx = (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, a.attempt.id)))[0];
      expect(tx.platformReference).toBe(a.attempt.providerReference);
    });

    it('a paid order whose receipt never came keeps going, and a person can add the reference later without moving its stage', async () => {
      const p = await provider();
      const a = await startPayment(p);
      stkQuery(0);
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('confirmed');
      const paid = await order(a.orderId);
      expect(paid).toMatchObject({ paymentStatus: 'paid', status: 'processing', transactionReference: null, mpesaReceiptNumber: null });

      await db.update(schema.orders).set({ status: 'shipped' }).where(eq(schema.orders.id, a.orderId));
      const ask = (reference: string, reason = 'Checked against the M-Pesa statement') => engine.attachOrderReference({ orderId: a.orderId, reference, reason, userId: 'u1' });
      expect(await ask('ws_CO_123456789')).toMatchObject({ ok: false });
      expect(await ask('AB')).toMatchObject({ ok: false });
      expect(await ask('QWE7RT61SV', 'short')).toMatchObject({ ok: false });
      expect(await ask('QWE7RT61SV')).toEqual({ ok: true });
      expect(await order(a.orderId)).toMatchObject({ status: 'shipped', transactionReference: 'QWE7RT61SV', mpesaReceiptNumber: 'QWE7RT61SV' });

      // The same number cannot also pay for another order.
      const b = await startPayment(p);
      stkQuery(0);
      await engine.verification.verifyAttempt(b.attempt.id);
      expect(await engine.attachOrderReference({ orderId: b.orderId, reference: 'QWE7RT61SV', reason: 'Trying the same number again', userId: 'u2' })).toMatchObject({ ok: false });
      expect((await order(b.orderId)).transactionReference).toBeNull();
    });

    it('while Safaricom is still processing, it asks again later and never decides early', async () => {
      const p = await provider();
      const a = await startPayment(p);
      stkQuery(null);
      jobCalls.length = 0;
      const v = await engine.verification.verifyAttempt(a.attempt.id);
      expect(v.outcome).toBe('pending');
      expect((await reload(a.attempt.id)).status).toBe('pending');
      expect(jobCalls.find((j) => j[0] === 'attempt' && j[1] === a.attempt.id)?.[2]).toBeGreaterThan(0);
      stkQuery(0);
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('confirmed');
    });

    it('a network failure is retried later, not treated as an answer', async () => {
      const p = await provider();
      const a = await startPayment(p);
      fake.down = true;
      const v = await engine.verification.verifyAttempt(a.attempt.id);
      fake.down = false;
      expect(v.outcome).toBe('error');
      expect((await reload(a.attempt.id)).status).toBe('pending');
    });

    it('past the window it is left in doubt for a person, with the reason, not failed', async () => {
      const p = await provider({ settings: { verification: { windowMinutes: 5 } } });
      const a = await startPayment(p);
      await callback(a.attempt, stkBody(a.attempt));
      await db.update(schema.paymentAttempts).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.paymentAttempts.id, a.attempt.id));
      stkQuery(null);
      const v = await engine.verification.verifyAttempt(a.attempt.id);
      expect(v.reason).toMatch(/needs a person/);
      expect((await reload(a.attempt.id)).status).toBe('pending');
      expect((await events(a.attempt.id))[0]).toMatchObject({ state: 'unverified', failureCode: 'IN_DOUBT' });
    });

    it('the same callback twice is logged twice and counted once; the same receipt cannot pay for two orders', async () => {
      const p = await provider();
      const a = await startPayment(p);
      const body = stkBody(a.attempt, { receipt: `${run}DUP1` });
      await callback(a.attempt, body);
      await callback(a.attempt, body);
      const evs = await events(a.attempt.id);
      expect(evs).toHaveLength(2);
      expect(evs.filter((e) => e.duplicateOf !== null)).toHaveLength(1);
      stkQuery(0);
      await engine.verification.verifyAttempt(a.attempt.id);
      expect(await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, `${run}DUP1`))).toHaveLength(1);
      const b = await startPayment(p);
      await callback(b.attempt, stkBody(b.attempt, { receipt: `${run}DUP1` }));
      const v = await engine.verification.verifyAttempt(b.attempt.id);
      expect(v.outcome).toBe('mismatch');
      expect((await order(b.orderId)).paymentStatus).not.toBe('paid');
    });

    it('refuses callbacks from addresses that are not allowed, and for addresses it never gave out', async () => {
      const p = await provider({ settings: { security: { allowedCidrs: ['196.201.214.0/24'] } } });
      const a = await startPayment(p);
      expect(await callback(a.attempt, stkBody(a.attempt), '203.0.113.9')).toMatchObject({ httpStatus: 403 });
      expect((await events(a.attempt.id))[0]).toMatchObject({ state: 'rejected', failureCode: 'IP_NOT_ALLOWED' });
      expect(await engine.ingestAttemptCallback({ token: 'nope', rawText: '{}', headers: {}, sourceIp: '1.1.1.1', https: true, method: 'POST' })).toMatchObject({ httpStatus: 404 });
      expect(await callback(a.attempt, stkBody(a.attempt), '196.201.214.7')).toMatchObject({ httpStatus: 200 });
    });

    it('strict mode also needs Safaricom\'s record of the transaction by its receipt, and that must agree', async () => {
      const p = await provider({ initiator: true, settings: { verification: { mode: 'strict' } } });
      const a = await startPayment(p);
      const receipt = rc();
      await callback(a.attempt, stkBody(a.attempt, { receipt }));
      stkQuery(0);
      fake.on('/mpesa/transactionstatus/v1/query', (b) => ({ json: { OriginatorConversationID: 'x', ConversationID: 'AG_1', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.', received: b.TransactionID } }));
      jobCalls.length = 0;
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('pending');
      expect((await reload(a.attempt.id)).status).toBe('pending');
      const op = (await engine.ops.bySubject('payment_attempt', a.attempt.id, 'transaction_status'))[0];
      expect(op).toMatchObject({ status: 'accepted', platformReference: null });
      const sent = required(fake.calls.filter((c) => c.path === '/mpesa/transactionstatus/v1/query').at(-1)).body;
      expect(sent).toMatchObject({ TransactionID: receipt, CommandID: 'TransactionStatusQuery', Initiator: 'apiuser', IdentifierType: '4' });
      expect(String(sent.SecurityCredential).length).toBeGreaterThan(100);
      expect(String(sent.ResultURL)).toMatch(/\/api\/hooks\/pay\/.+\/result\//);
      // the result comes back on the provider's address, with its secret
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const result = (agrees: boolean) => ({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: op.originatorId, ConversationID: 'AG_1', TransactionID: 'OPSNEW0001', ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: receipt }, { Key: 'Amount', Value: agrees ? 100 : 7 }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'CreditPartyName', Value: '174379 - Engine' }] } } });
      const wrong = await engine.ingestHook({ providerId: p.providerId, kind: 'result', secret: 'wrong', rawText: JSON.stringify(result(true)), headers: {}, sourceIp: '196.201.214.200', https: true, method: 'POST' });
      expect(wrong.httpStatus).toBe(404);
      expect((await engine.ops.get(op.id)).status).toBe('accepted');
      const ok = await engine.ingestHook({ providerId: p.providerId, kind: 'result', secret, rawText: JSON.stringify(result(true)), headers: {}, sourceIp: '196.201.214.200', https: true, method: 'POST' });
      expect(ok.httpStatus).toBe(200);
      expect((await engine.ops.get(op.id)).status).toBe('succeeded');
      expect(jobCalls.some((j) => j[0] === 'attempt' && j[1] === a.attempt.id)).toBe(true);
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('confirmed');
      expect((await order(a.orderId)).paymentStatus).toBe('paid');
      const tx = (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, a.attempt.id)))[0];
      expect(tx.verifiedBy).toBe('stk_query+transaction_status');
    });

    it('strict mode refuses when the transaction record disagrees about the amount', async () => {
      const p = await provider({ initiator: true, settings: { verification: { mode: 'strict' } } });
      const a = await startPayment(p);
      const receipt = rc();
      await callback(a.attempt, stkBody(a.attempt, { receipt }));
      stkQuery(0);
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: 'AG_2', ResponseCode: '0', ResponseDescription: 'ok' } }));
      await engine.verification.verifyAttempt(a.attempt.id);
      const op = (await engine.ops.bySubject('payment_attempt', a.attempt.id, 'transaction_status'))[0];
      const secret = await engine.contexts.callbackSecret(p.providerId);
      await engine.ingestHook({ providerId: p.providerId, kind: 'result', secret, rawText: JSON.stringify({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: op.originatorId, ConversationID: 'AG_2', ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: receipt }, { Key: 'Amount', Value: 7 }, { Key: 'TransactionStatus', Value: 'Completed' }] } } }), headers: {}, sourceIp: null, https: true, method: 'POST' });
      const v = await engine.verification.verifyAttempt(a.attempt.id);
      expect(v.outcome).toBe('mismatch');
      expect((await order(a.orderId)).paymentStatus).not.toBe('paid');
    });
  });

  describe('a platform whose answer cannot be used is never counted by itself', () => {
    async function jengaAttempt(existing?: { providerId: string; methodId: string }) {
      const p = existing ?? (await provider({ code: 'jenga_hq' }));
      seq += 1;
      const orderId = `jg_${run}_${seq}`;
      await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, payment_status)
        VALUES (${orderId}, ${`JG-${run}-${seq}`}, 'u', ${branch.id}::uuid, 'n', 'e@x.io', '0712345678', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 86.2, 13.8, 0, 100, 'jenga_hq', 'pending')`);
      const [attempt] = await db.insert(schema.paymentAttempts).values({ branchId: branch.id, providerConfigId: p.providerId, providerCode: 'jenga_hq', orderId, orderNumber: `JG-${run}-${seq}`, amount: '100.00', currency: 'KES', status: 'pending', callbackToken: `jg-token-${run}-${seq}-padding-padding`, callbackUrl: 'https://x.test', customerPhone: '0712345678' }).returning();
      return { p, attempt, orderId };
    }
    it('a Jenga callback with no usable answer from Jenga is written down and left unverified, with the reason; the order is not paid', async () => {
      fake.on('/authentication/api/v3/authenticate/merchant', () => ({ json: { accessToken: 'jt' } }));
      fake.on('/v3-apis/transaction-api/v3.0/payments/*', () => ({ status: 404, json: { message: 'No such payment' } }));
      const { attempt, orderId } = await jengaAttempt();
      const reply = await engine.ingestAttemptCallback({ token: attempt.callbackToken, rawText: JSON.stringify({ reference: attempt.orderNumber.replace(/[^A-Za-z0-9]/g, ''), transactionReference: 'JG123', status: 'success' }), headers: {}, sourceIp: '1.2.3.4', https: true, method: 'POST' });
      expect(reply.httpStatus).toBe(200);
      expect((await engine.verification.verifyAttempt(attempt.id)).outcome).toBe('error');
      expect((await reload(attempt.id)).status).toBe('pending');
      expect((await order(orderId)).paymentStatus).not.toBe('paid');
      expect((await events(attempt.id))[0]).toMatchObject({ state: 'unverified', failureCode: 'CANNOT_VERIFY' });
    });
    it('a person can confirm it by hand, but only with the platform\'s number and a reason, and never twice for one number', async () => {
      fake.on('/authentication/api/v3/authenticate/merchant', () => ({ json: { accessToken: 'jt' } }));
      fake.on('/v3-apis/transaction-api/v3.0/payments/*', () => ({ status: 404, json: { message: 'No such payment' } }));
      const { attempt, orderId } = await jengaAttempt();
      await engine.ingestAttemptCallback({ token: attempt.callbackToken, rawText: JSON.stringify({ reference: attempt.orderNumber.replace(/[^A-Za-z0-9]/g, ''), transactionReference: 'JG1', status: 'success' }), headers: {}, sourceIp: null, https: true, method: 'POST' });
      await engine.verification.verifyAttempt(attempt.id);
      expect(await engine.confirmAttemptManually({ attemptId: attempt.id, reference: 'x', reason: 'I saw it in the Jenga portal', userId: 'u1' })).toMatchObject({ ok: false });
      expect(await engine.confirmAttemptManually({ attemptId: attempt.id, reference: 'JGREF-0001', reason: 'short', userId: 'u1' })).toMatchObject({ ok: false });
      expect(await engine.confirmAttemptManually({ attemptId: attempt.id, reference: 'JGREF-0001', reason: 'Seen in the Jenga portal under today\'s receipts', userId: 'u1' })).toEqual({ ok: true });
      expect((await order(orderId)).paymentStatus).toBe('paid');
      const tx = (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, attempt.id)))[0];
      expect(tx).toMatchObject({ verifiedBy: 'manual', platformReference: 'JGREF-0001' });
      expect(JSON.stringify(tx.evidence)).toContain('Seen in the Jenga portal');
      const other = await jengaAttempt(await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.providerId, attempt.providerConfigId)).then((m) => ({ providerId: attempt.providerConfigId, methodId: m[0].id })));
      expect(await engine.confirmAttemptManually({ attemptId: other.attempt.id, reference: 'JGREF-0001', reason: 'Trying the same number again', userId: 'u2' })).toMatchObject({ ok: false });
      expect(await engine.confirmAttemptManually({ attemptId: attempt.id, reference: 'JGREF-0002', reason: 'It is already paid so this is refused', userId: 'u1' })).toMatchObject({ ok: false });
    });
    it('a payment the checks contradicted cannot be confirmed by hand, but a person can close one that never completed', async () => {
      const p = await provider();
      const a = await startPayment(p, { amount: 500 });
      await callback(a.attempt, stkBody(a.attempt, { amount: 5 }));
      await engine.verification.verifyAttempt(a.attempt.id);
      expect(await engine.confirmAttemptManually({ attemptId: a.attempt.id, reference: 'FORCE00001', reason: 'The customer says they paid, trust me', userId: 'u1' })).toMatchObject({ ok: false, error: expect.stringMatching(/contradict/) as unknown });
      expect(await engine.failAttemptManually({ attemptId: a.attempt.id, reason: 'x', userId: 'u1' })).toMatchObject({ ok: false });
      expect(await engine.failAttemptManually({ attemptId: a.attempt.id, reason: 'The customer confirmed they never paid', userId: 'u1' })).toEqual({ ok: true });
      expect((await reload(a.attempt.id)).status).toBe('failed');
      expect((await events(a.attempt.id)).some((e) => e.kind === 'manual_failure')).toBe(true);
    });
    it('the safety net re-queues payments still waiting without pulling later checks forward', async () => {
      const p = await provider();
      const a = await startPayment(p);
      await db.update(schema.paymentAttempts).set({ createdAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.paymentAttempts.id, a.attempt.id));
      jobCalls.length = 0;
      expect(await engine.sweepAttempts()).toBeGreaterThanOrEqual(1);
      expect(jobCalls.some((j) => j[0] === 'attempt' && j[1] === a.attempt.id)).toBe(true);
    });
  });

  describe('Pesapal: its own status for the order decides', () => {
    const pesapalOk = (over: Record<string, unknown> = {}) => {
      fake.on('/api/Auth/RequestToken', () => ({ json: { token: 'pt' } }));
      fake.on('/api/Transactions/GetTransactionStatus', (_b, u) => ({ json: { payment_status_description: 'Completed', status_code: 1, merchant_reference: u.searchParams.get('merchantRef') ?? 'x', amount: 100, currency: 'KES', confirmation_code: 'PSP-CONF-1', ...over } }));
    };
    async function pesapalAttempt(p: { providerId: string }) {
      fake.on('/api/Auth/RequestToken', () => ({ json: { token: 'pt' } }));
      fake.on('/api/Transactions/SubmitOrderRequest', (b) => ({ json: { order_tracking_id: `trk-${randomUUID().slice(0, 8)}`, merchant_reference: String(b.id), redirect_url: 'https://pay.pesapal.test/x', status: '200' } }));
      return await startPayment(p, { code: 'pesapal_v3' });
    }
    it('an IPN with no secret in its address only points at the order; Pesapal confirms it', async () => {
      const p = await provider({ code: 'pesapal_v3' });
      const a = await pesapalAttempt(p);
      expect(a.attempt.status).toBe('awaiting_redirect');
      pesapalOk({ merchant_reference: a.number });
      const reply = await engine.ingestAttemptCallback({ trackingId: required(a.attempt.externalReference), rawText: JSON.stringify({ OrderTrackingId: a.attempt.externalReference, OrderMerchantReference: a.number, OrderNotificationType: 'IPNCHANGE' }), headers: {}, sourceIp: '1.2.3.4', https: true, method: 'POST' });
      expect(reply.httpStatus).toBe(200);
      expect((await order(a.orderId)).paymentStatus).not.toBe('paid');
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('confirmed');
      expect((await order(a.orderId)).paymentStatus).toBe('paid');
      expect((await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, a.attempt.id)))[0].platformReference).toBe('PSP-CONF-1');
    });
    it('refuses a payment whose amount, reference or status differs from what we asked for', async () => {
      const p = await provider({ code: 'pesapal_v3' });
      const a = await pesapalAttempt(p);
      pesapalOk({ merchant_reference: a.number, amount: 1 });
      await engine.ingestAttemptCallback({ trackingId: required(a.attempt.externalReference), rawText: JSON.stringify({ OrderTrackingId: a.attempt.externalReference }), headers: {}, sourceIp: null, https: true, method: 'POST' });
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('mismatch');
      pesapalOk({ merchant_reference: 'SOMEONE-ELSE' });
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('mismatch');
      pesapalOk({ merchant_reference: a.number, payment_status_description: 'Failed', status_code: 2 });
      expect((await engine.verification.verifyAttempt(a.attempt.id)).outcome).toBe('failed');
      expect((await order(a.orderId)).paymentStatus).toBe('failed');
    });
  });

  describe('Jenga and KCB: their own record of the payment decides', () => {
    const refOf = (number: string) => number.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
    async function jengaPaid(over: Record<string, unknown> = {}, status = 200) {
      fake.on('/authentication/api/v3/authenticate/merchant', () => ({ json: { accessToken: 'jt' } }));
      fake.on('/v3-apis/transaction-api/v3.0/payments', (b) => ({ json: { transactionId: `JGTX-${run}-${++seq}`, reference: String((b.payment as Record<string, unknown>).ref) } }));
      const p = await provider({ code: 'jenga_hq' });
      const a = await startPayment(p, { code: 'jenga_hq' });
      fake.on('/v3-apis/transaction-api/v3.0/payments/*', () => ({ status, json: { status: 'SUCCESS', transactionId: `JGREC-${run}-${seq}`, reference: refOf(a.number), amount: 100, currency: 'KES', ...over } }));
      await callback(a.attempt, { reference: refOf(a.number), status: 'success', amount: 100 });
      return { ...a, verify: () => engine.verification.verifyAttempt(a.attempt.id) };
    }
    it('Jenga: a callback only points at the payment; Jenga\'s own answer, asked by our reference, makes it paid', async () => {
      const a = await jengaPaid();
      expect((await order(a.orderId)).paymentStatus).not.toBe('paid');
      expect((await a.verify()).outcome).toBe('confirmed');
      expect((await order(a.orderId)).paymentStatus).toBe('paid');
      const asked = fake.calls.filter((c) => c.path.startsWith('/v3-apis/transaction-api/v3.0/payments/')).at(-1);
      expect(asked?.method).toBe('GET');
      expect(asked?.path.endsWith(refOf(a.number))).toBe(true);
      expect((await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, a.attempt.id)))[0].platformReference).toMatch(/^JGREC-/);
    });
    it('Jenga: a different amount, order or currency is refused, a decline fails the payment, and no answer leaves it waiting', async () => {
      const wrongAmount = await jengaPaid({ amount: 1 });
      expect((await wrongAmount.verify()).outcome).toBe('mismatch');
      const wrongOrder = await jengaPaid({ reference: 'SOMEONEELSE' });
      expect((await wrongOrder.verify()).outcome).toBe('mismatch');
      const wrongCurrency = await jengaPaid({ currency: 'USD' });
      expect((await wrongCurrency.verify()).outcome).toBe('mismatch');
      for (const x of [wrongAmount, wrongOrder, wrongCurrency]) expect((await order(x.orderId)).paymentStatus).not.toBe('paid');
      const declined = await jengaPaid({ status: 'FAILED', message: 'Insufficient funds' });
      expect((await declined.verify()).outcome).toBe('failed');
      expect((await order(declined.orderId)).paymentStatus).toBe('failed');
      const waiting = await jengaPaid({ status: 'PENDING' });
      expect((await waiting.verify()).outcome).toBe('pending');
      const down = await jengaPaid({}, 503);
      expect((await down.verify()).outcome).toBe('error');
      expect((await order(down.orderId)).paymentStatus).not.toBe('paid');
    });
    it('Jenga: a callback that names another payment is refused before Jenga is asked', async () => {
      const a = await jengaPaid();
      const before = fake.calls.length;
      await callback(a.attempt, { reference: 'NOTOURS', status: 'success' });
      expect((await a.verify()).outcome).toBe('mismatch');
      expect(fake.calls.slice(before).some((c) => c.path.startsWith('/v3-apis/transaction-api/v3.0/payments/'))).toBe(false);
    });

    async function kcbPaid(over: Record<string, unknown> = {}, status = 200) {
      let n = 0;
      fake.on('/token', () => ({ json: { access_token: 'kt' } }));
      fake.on('/mm/api/request/1.0.0/stkpush', () => ({ json: { checkoutRequestID: `ws_KCB_${run}_${++n}_${++seq}`, MerchantRequestID: `KM-${run}-${seq}`, customerMessage: 'Sent' } }));
      const p = await provider({ code: 'kcb_buni' });
      const a = await startPayment(p, { code: 'kcb_buni' });
      fake.on('/mm/api/request/1.0.0/stkpushquery', (b) => ({ status, json: { CheckoutRequestID: String(b.checkoutRequestID), ResultCode: '0', ResultDesc: 'Processed', Amount: 100, MpesaReceiptNumber: `KCBREC${run}${seq}`, ...over } }));
      await callback(a.attempt, stkBody(a.attempt));
      return { ...a, verify: () => engine.verification.verifyAttempt(a.attempt.id) };
    }
    it('KCB: the callback points at the payment; KCB\'s own answer for the checkout request makes it paid', async () => {
      const a = await kcbPaid();
      expect((await order(a.orderId)).paymentStatus).not.toBe('paid');
      expect((await a.verify()).outcome).toBe('confirmed');
      expect((await order(a.orderId)).paymentStatus).toBe('paid');
      const asked = fake.calls.filter((c) => c.path === '/mm/api/request/1.0.0/stkpushquery').at(-1);
      expect(asked?.body).toMatchObject({ checkoutRequestID: a.attempt.providerReference, orgShortCode: '174379' });
      expect((await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, a.attempt.id)))[0].platformReference).toMatch(/^KCBREC/);
    });
    it('KCB: a different amount is refused, a declined request fails the payment, and no answer leaves it waiting', async () => {
      const wrongAmount = await kcbPaid({ Amount: 1 });
      expect((await wrongAmount.verify()).outcome).toBe('mismatch');
      expect((await order(wrongAmount.orderId)).paymentStatus).not.toBe('paid');
      const declined = await kcbPaid({ ResultCode: '1032', ResultDesc: 'Request cancelled by user' });
      expect((await declined.verify()).outcome).toBe('failed');
      expect((await order(declined.orderId)).paymentStatus).toBe('failed');
      const noCode = await kcbPaid({ ResultCode: null });
      expect((await noCode.verify()).outcome).toBe('error');
      const down = await kcbPaid({}, 503);
      expect((await down.verify()).outcome).toBe('error');
      expect((await order(down.orderId)).paymentStatus).not.toBe('paid');
    });
  });

  describe('payments made straight to a paybill or till', () => {
    const hook = (p: { providerId: string }, kind: 'c2b-validate' | 'c2b-confirm' | 'result' | 'timeout', body: unknown, secret: string, ip: string | null = '196.201.214.200') =>
      engine.ingestHook({ providerId: p.providerId, kind, secret, rawText: JSON.stringify(body), headers: {}, sourceIp: ip, https: true, method: 'POST' });
    const c2b = (o: { id?: string; amount?: string; shortcode?: string; ref?: string } = {}) => ({ TransactionType: 'Pay Bill', TransID: o.id ?? rc(), TransTime: '20260113123045', TransAmount: o.amount ?? '250.00', BusinessShortCode: o.shortcode ?? '600638', BillRefNumber: o.ref ?? 'ACCT', InvoiceNumber: '', OrgAccountBalance: '9999.00', ThirdPartyTransID: '', MSISDN: '2547 ***** 126', FirstName: 'Jane', MiddleName: '', LastName: 'Doe' });
    const customer = async (number: string) => (await db.insert(schema.customers).values({ companyId, number, name: `Payer ${number}`, phone: '0711000111', accountType: 'cash', creditLimit: '0' }).returning())[0];
    const txOf = async (ref: string) => (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, ref)))[0];

    it('registering the addresses uses the provider\'s secret, with none of the words Safaricom refuses', async () => {
      const p = await provider({ channel: '600638' });
      fake.on('/mpesa/c2b/v2/registerurl', () => ({ json: { OriginatorCoversationID: 'x', ResponseCode: '0', ResponseDescription: 'success' } }));
      const { op } = await engine.daraja.start({ providerId: p.providerId, operation: 'c2b_register_urls', input: { shortcode: '600638' }, idempotencyKey: `reg:${p.providerId}` });
      expect(op.status).toBe('succeeded');
      const sent = required(fake.calls.filter((c) => c.path === '/mpesa/c2b/v2/registerurl').at(-1)).body;
      expect(sent).toMatchObject({ ShortCode: '600638', ResponseType: 'Completed' });
      expect(String(sent.ConfirmationURL)).toMatch(/^https:\/\/shop\.example\/api\/hooks\/pay\/[0-9a-f-]{36}\/c2b-confirm\/[A-Za-z0-9_-]{43}$/);
      expect(String(sent.ConfirmationURL)).not.toMatch(/(mpesa|safaricom|exe|exec|cmd|sql|query)/i);
      expect(JSON.stringify(op.request)).toContain('[secret]');
      // asking again is the same operation
      const again = await engine.daraja.start({ providerId: p.providerId, operation: 'c2b_register_urls', input: { shortcode: '600638' }, idempotencyKey: `reg:${p.providerId}` });
      expect(again.created).toBe(false);
    });

    it('validation answers by the provider\'s policy and refuses shortcodes that are not its own', async () => {
      const p = await provider({ channel: '600638', settings: { c2b: { validation: 'known_reference' } } });
      await customer(`V${run}${++seq}`);
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const unknownRef = await hook(p, 'c2b-validate', { ...c2b(), TransID: '', BillRefNumber: 'NOBODY' }, secret);
      expect(unknownRef.body).toEqual({ ResultCode: 'C2B00012', ResultDesc: 'Rejected' });
      const wrongCode = await hook(p, 'c2b-validate', { ...c2b({ shortcode: '999999' }) }, secret);
      expect(wrongCode.body).toEqual({ ResultCode: 'C2B00015', ResultDesc: 'Rejected' });
      await setSettings(p.providerId, { c2b: { validation: 'accept_all' } });
      expect((await hook(p, 'c2b-validate', c2b(), secret)).body).toEqual({ ResultCode: '0', ResultDesc: 'Accepted' });
      expect((await hook(p, 'c2b-validate', c2b(), 'wrong')).httpStatus).toBe(404);
    });

    it('a confirmation is claimed once, confirmed with Safaricom by Transaction Status, then put on the customer\'s account', async () => {
      const p = await provider({ channel: '600638', initiator: true, autoAllocate: true });
      const number = `C${run}${++seq}`;
      const cust = await customer(number);
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const id = rc();
      jobCalls.length = 0;
      const reply = await hook(p, 'c2b-confirm', c2b({ id, ref: number, amount: '250.00' }), secret);
      expect(reply).toMatchObject({ httpStatus: 200, body: { ResultCode: '0' } });
      let tx = await txOf(id);
      expect(tx).toMatchObject({ state: 'claimed', kind: 'c2b', amount: '250.0000', shortcode: '600638', accountReference: number, methodId: p.methodId });
      expect(jobCalls.some((j) => j[0] === 'transaction' && j[1] === tx.id)).toBe(true);
      // the same announcement again changes nothing
      await hook(p, 'c2b-confirm', c2b({ id, ref: number, amount: '250.00' }), secret);
      expect(await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, id))).toHaveLength(1);
      // not counted yet: nobody has asked Safaricom
      expect((await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.externalReference, id))).length).toBe(0);
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: 'AG_C2B', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      expect((await engine.c2b.verify(tx.id)).state).toBe('waiting');
      const op = (await engine.ops.bySubject('provider_transaction', tx.id, 'transaction_status'))[0];
      const done = await hook(p, 'result', { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: op.originatorId, ConversationID: 'AG_C2B', ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: id }, { Key: 'Amount', Value: 250 }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'CreditPartyName', Value: '600638 - Acme' }] } } }, secret);
      expect(done.httpStatus).toBe(200);
      expect(jobCalls.some((j) => j[0] === 'transaction' && j[1] === tx.id)).toBe(true);
      expect((await engine.c2b.verify(tx.id)).state).toBe('consumed');
      tx = await txOf(id);
      expect(tx).toMatchObject({ state: 'consumed', consumedType: 'customer_receipt', verifiedBy: 'transaction_status' });
      const [receipt] = await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.id, required(tx.consumedId)));
      expect(receipt).toMatchObject({ customerId: cust.id, status: 'posted', amount: '250.00', externalReference: id, source: 'gateway', paymentMethodId: p.methodId, branchId: branch.id });
      const [entry] = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, receipt.id));
      expect(entry).toMatchObject({ amount: '250.0000', glAccountId: glMobile, bankAccountId: bankId });
      // finishing again does nothing more
      expect((await engine.c2b.verify(tx.id)).state).toBe('consumed');
      expect(await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.externalReference, id))).toHaveLength(1);
    });

    it('refuses what Safaricom\'s record contradicts (a different amount) and what is not one of its shortcodes', async () => {
      const p = await provider({ channel: '600638', initiator: true });
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const id = rc();
      await hook(p, 'c2b-confirm', c2b({ id, amount: '250.00' }), secret);
      const tx = await txOf(id);
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: 'AG_BAD', ResponseCode: '0', ResponseDescription: 'ok' } }));
      await engine.c2b.verify(tx.id);
      const op = (await engine.ops.bySubject('provider_transaction', tx.id, 'transaction_status'))[0];
      await hook(p, 'result', { Result: { ResultCode: 0, OriginatorConversationID: op.originatorId, ConversationID: 'AG_BAD', ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: id }, { Key: 'Amount', Value: 25 }, { Key: 'TransactionStatus', Value: 'Completed' }] } } }, secret);
      expect((await engine.c2b.verify(tx.id)).state).toBe('rejected');
      expect(await txOf(id)).toMatchObject({ state: 'rejected', failureCode: 'STATUS_AMOUNT_MISMATCH' });
      const other = rc();
      await hook(p, 'c2b-confirm', c2b({ id: other, shortcode: '999999' }), secret);
      expect(await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, other))).toHaveLength(0);
      const evs = await db.select().from(schema.providerEvents).where(and(eq(schema.providerEvents.providerId, p.providerId), eq(schema.providerEvents.kind, 'c2b_confirmation'), eq(schema.providerEvents.state, 'mismatch')));
      expect(evs.some((e) => e.failureCode === 'UNKNOWN_SHORTCODE')).toBe(true);
    });

    it('with no way to confirm with Safaricom, a payment stays claimed: the callback alone is never enough', async () => {
      const p = await provider({ channel: '600638', autoAllocate: true });
      const number = `N${run}${++seq}`;
      await customer(number);
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const id = rc();
      await hook(p, 'c2b-confirm', c2b({ id, ref: number }), secret);
      const tx = await txOf(id);
      expect((await engine.c2b.verify(tx.id)).state).toBe('claimed');
      expect(await txOf(id)).toMatchObject({ state: 'claimed', failureCode: 'NO_VERIFICATION_METHOD' });
      expect((await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.externalReference, id))).length).toBe(0);
    });

    it('a verified payment for an account number nobody owns waits for a person, and a rejected source is only recorded', async () => {
      const p = await provider({ channel: '600638', initiator: true, autoAllocate: true });
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const id = rc();
      await hook(p, 'c2b-confirm', c2b({ id, ref: 'NOBODY-HERE' }), secret);
      const tx = await txOf(id);
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: 'AG_REV', ResponseCode: '0', ResponseDescription: 'ok' } }));
      await engine.c2b.verify(tx.id);
      const op = (await engine.ops.bySubject('provider_transaction', tx.id, 'transaction_status'))[0];
      await hook(p, 'result', { Result: { ResultCode: 0, OriginatorConversationID: op.originatorId, ConversationID: 'AG_REV', ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: id }, { Key: 'Amount', Value: 250 }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'CreditPartyName', Value: '600638 - Acme' }] } } }, secret);
      expect((await engine.c2b.verify(tx.id)).state).toBe('review');
      expect((await txOf(id)).state).toBe('review');
      const blocked = await hook(p, 'c2b-confirm', c2b(), secret, '203.0.113.50');
      expect(blocked.httpStatus).toBe(200); // no allow-list set: any address
      await setSettings(p.providerId, { security: { allowedCidrs: ['196.201.214.0/24'] } });
      const refused = await hook(p, 'c2b-confirm', c2b({ id: rc() }), secret, '203.0.113.50');
      expect(refused.httpStatus).toBe(403);
    });

    it('a person places a confirmed payment on a customer, or sets it aside with a reason', async () => {
      const p = await provider({ channel: '600638', initiator: true });
      const cust = await customer(`PL${run}${++seq}`);
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const confirmed = async (amount: string) => {
        const id = rc();
        await hook(p, 'c2b-confirm', c2b({ id, ref: 'UNKNOWN-REF', amount }), secret);
        const tx = await txOf(id);
        fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: `AG_${id}`, ResponseCode: '0', ResponseDescription: 'ok' } }));
        await engine.c2b.verify(tx.id);
        const op = (await engine.ops.bySubject('provider_transaction', tx.id, 'transaction_status'))[0];
        await hook(p, 'result', { Result: { ResultCode: 0, OriginatorConversationID: op.originatorId, ConversationID: `AG_${id}`, ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: id }, { Key: 'Amount', Value: Number(amount) }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'CreditPartyName', Value: '600638 - Acme' }] } } }, secret);
        expect((await engine.c2b.verify(tx.id)).state).toBe('review');
        return tx;
      };
      const tx = await confirmed('310.00');
      const placed = await engine.placeTransaction({ transactionId: tx.id, customerId: cust.id, userId: 'staff-1' });
      expect(placed).toMatchObject({ ok: true, type: 'customer_receipt' });
      const [r] = await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.externalReference, tx.platformReference));
      expect(r).toMatchObject({ customerId: cust.id, status: 'posted', amount: '310.00' });
      expect((await txOf(tx.platformReference)).state).toBe('consumed');
      expect(await engine.placeTransaction({ transactionId: tx.id, customerId: cust.id, userId: 'staff-1' })).toMatchObject({ ok: false });
      const other = await confirmed('20.00');
      expect(await engine.setAsideTransaction({ transactionId: other.id, reason: 'short', userId: 'staff-1' })).toMatchObject({ ok: false });
      expect(await engine.setAsideTransaction({ transactionId: other.id, reason: 'Paid to the wrong number by a customer of another shop', userId: 'staff-1' })).toEqual({ ok: true });
      expect(await txOf(other.platformReference)).toMatchObject({ state: 'rejected', failureCode: 'SET_ASIDE' });
    });

    it('the pull sweep takes in a payment whose callback never came, already confirmed by Safaricom', async () => {
      const p = await provider({ channel: '600638', autoAllocate: true, settings: { pull: { registered: true, nominatedNumber: '0722000000' } } });
      const number = `P${run}${++seq}`;
      const cust = await customer(number);
      const known = rc();
      const lost = rc();
      const secret = await engine.contexts.callbackSecret(p.providerId);
      await hook(p, 'c2b-confirm', c2b({ id: known, ref: number, amount: '100.00' }), secret);
      fake.on('/pulltransactions/v1/query', (b) => ({ json: { ResponseCode: '1000', ResponseMessage: 'Success', Response: [[
        { transactionId: known, trxDate: '2026-01-13T09:30:45Z', msisdn: 254712345678, billreference: number, amount: 100, transactiontype: 'c2b-pay-bill-debit' },
        { transactionId: lost, trxDate: '2026-01-13T09:31:45Z', msisdn: 254712345679, billreference: number, amount: 75.5, transactiontype: 'c2b-pay-bill-debit' },
      ]], received: b.ShortCode } }));
      const out = await engine.c2b.pullSweep(p.providerId);
      expect(out).toMatchObject({ checked: 2, found: 1, missing: 1 });
      const t = await txOf(lost);
      expect(t).toMatchObject({ state: 'consumed', consumedType: 'customer_receipt', verifiedBy: 'pull', amount: '75.5000', accountReference: number });
      expect(JSON.stringify(t.evidence)).toContain('by sweep, no callback had arrived');
      expect((await txOf(known)).state).toBe('consumed');
      const [r] = await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.id, required(t.consumedId)));
      expect(r.customerId).toBe(cust.id);
      // running it again finds nothing new
      expect((await engine.c2b.pullSweep(p.providerId)).missing).toBe(0);
    });
  });

  describe('operations are asked once, retried safely, and refused when switched off', () => {
    it('the same request is one operation; a platform that already has it counts as accepted; a network failure is retried with the same id', async () => {
      const p = await provider({ initiator: true });
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: 'AG_1', ResponseCode: '0', ResponseDescription: 'ok' } }));
      const key = `idem:${run}:${++seq}`;
      const a = await engine.daraja.start({ providerId: p.providerId, operation: 'transaction_status', input: { transactionId: 'ABC1234567', shortcode: '174379' }, idempotencyKey: key });
      const b = await engine.daraja.start({ providerId: p.providerId, operation: 'transaction_status', input: { transactionId: 'ABC1234567', shortcode: '174379' }, idempotencyKey: key });
      expect(b.created).toBe(false);
      expect(b.op.id).toBe(a.op.id);
      expect(fake.calls.filter((c) => c.body.TransactionID === 'ABC1234567')).toHaveLength(1);
      // duplicate originator at Safaricom
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ status: 500, json: { requestId: 'r', errorCode: '500.002.1001', errorMessage: 'Duplicate OriginatorConversationID.' } }));
      const dup = await engine.daraja.start({ providerId: p.providerId, operation: 'transaction_status', input: { transactionId: 'ABC1234568', shortcode: '174379' } });
      expect(dup.op.status).toBe('accepted');
      // the network is down: queued, resent later, same originator id
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: 'AG_9', ResponseCode: '0', ResponseDescription: 'ok' } }));
      fake.down = true;
      jobCalls.length = 0;
      const down = await engine.daraja.start({ providerId: p.providerId, operation: 'transaction_status', input: { transactionId: 'ABC1234569', shortcode: '174379' } });
      fake.down = false;
      expect(down.op).toMatchObject({ status: 'queued', failureCode: 'NO_RESPONSE' });
      expect(jobCalls.some((j) => j[0] === 'send' && j[1] === down.op.id)).toBe(true);
      await engine.daraja.send(down.op.id);
      const after = (await engine.ops.get(down.op.id));
      expect(after.status).toBe('accepted');
      expect(after.originatorId).toBe(down.op.originatorId);
    });

    it('a customer prompt is never sent twice on an unanswered request', async () => {
      const p = await provider();
      fake.on('/mpesa/stkpush/v1/processrequest', () => ({ status: 500, json: null, text: '' }));
      fake.down = true;
      const out = await startPayment(p);
      fake.down = false;
      stkOk();
      expect(out.attempt.status).toBe('failed');
      expect(fake.calls.filter((c) => c.path === '/mpesa/stkpush/v1/processrequest' && c.body.PartyA === '254712345678').length).toBeGreaterThanOrEqual(1);
      const op = (await engine.ops.bySubject('payment_attempt', out.attempt.id, 'stk_push'))[0];
      expect(op.status).toBe('failed');
      expect(op.attempts).toBe(1);
    });

    it('refuses operations that are off, sandbox-only ones in production, ones over their limit, and ones that need the API operator', async () => {
      const p = await provider({ settings: { operations: { qr_generate: { enabled: false }, stk_query: { maxAmount: '10' } } } });
      await expect(engine.daraja.start({ providerId: p.providerId, operation: 'qr_generate', input: {} })).rejects.toMatchObject({ code: 'OPERATION_OFF' });
      await expect(engine.daraja.start({ providerId: p.providerId, operation: 'stk_query', input: { checkoutRequestId: 'x', amount: 50 } })).rejects.toMatchObject({ code: 'OVER_LIMIT' });
      await expect(engine.daraja.start({ providerId: p.providerId, operation: 'transaction_status', input: { transactionId: 'ABC1234567' } })).rejects.toMatchObject({ code: 'NO_INITIATOR' });
      await db.update(schema.paymentProviderConfigs).set({ environment: 'production' }).where(eq(schema.paymentProviderConfigs.id, p.providerId));
      await expect(engine.daraja.start({ providerId: p.providerId, operation: 'c2b_simulate', input: { amount: 1 } })).rejects.toMatchObject({ code: 'SANDBOX_ONLY' });
    });

    it('a dynamic QR code comes back and is kept with the operation', async () => {
      const p = await provider();
      fake.on('/mpesa/qrcode/v1/generate', (b) => ({ json: { ResponseCode: 'AG_2026', RequestID: 'r', ResponseDescription: 'QR Code Successfully Generated.', QRCode: 'iVBORw0KGgoAAAANSUhEUg', echo: b.CPI } }));
      const { op } = await engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: 'qr_generate', input: { merchantName: 'Acme Shop', refNo: 'INV-1', amount: 250, trxCode: 'BG', size: '300' } });
      expect(op.status).toBe('succeeded');
      expect((op.result as { QRCode?: string }).QRCode).toBe('iVBORw0KGgoAAAANSUhEUg');
      expect(required(fake.calls.filter((c) => c.path === '/mpesa/qrcode/v1/generate').at(-1)).body).toMatchObject({ MerchantName: 'Acme Shop', TrxCode: 'BG', CPI: '174379', Amount: 250 });
    });

    it('a customer prompt is closed off with the payment: succeeded when paid, failed when not, never "in doubt" for want of a result address', async () => {
      const p = await provider();
      const good = await startPayment(p);
      const bad = await startPayment(p);
      const pending = await startPayment(p);
      await db.update(schema.paymentAttempts).set({ status: 'successful' }).where(eq(schema.paymentAttempts.id, good.attempt.id));
      await db.update(schema.paymentAttempts).set({ status: 'failed', errorMessage: 'Request cancelled by user' }).where(eq(schema.paymentAttempts.id, bad.attempt.id));
      await db.update(schema.providerOperations).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(and(eq(schema.providerOperations.operation, 'stk_push'), eq(schema.providerOperations.providerId, p.providerId)));
      await engine.sweep();
      const opOf = async (id: string) => (await engine.ops.bySubject('payment_attempt', id, 'stk_push'))[0];
      expect((await opOf(good.attempt.id)).status).toBe('succeeded');
      expect(await opOf(bad.attempt.id)).toMatchObject({ status: 'failed', failureReason: 'Request cancelled by user' });
      const wait = await opOf(pending.attempt.id);
      expect(wait.status).toBe('accepted');
      expect(required(wait.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
    });

    it('an answer we did not ask for is recorded and matched to nothing', async () => {
      const p = await provider({ initiator: true });
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const r = await engine.ingestHook({ providerId: p.providerId, kind: 'result', secret, rawText: JSON.stringify({ Result: { ResultCode: 0, OriginatorConversationID: 'never-sent', ConversationID: 'AG_X', ResultParameters: { ResultParameter: [] } } }), headers: {}, sourceIp: null, https: true, method: 'POST' });
      expect(r.httpStatus).toBe(200);
      const ev = (await db.select().from(schema.providerEvents).where(and(eq(schema.providerEvents.providerId, p.providerId), eq(schema.providerEvents.kind, 'result'))).orderBy(desc(schema.providerEvents.createdAt)))[0];
      expect(ev).toMatchObject({ state: 'unmatched', failureCode: 'NO_OPERATION' });
    });
  });

  describe('provider settings', () => {
    it('are saved cleaned up, refuse a bad address range, and change what the engine does', async () => {
      const p = await provider({ initiator: true });
      const ctxu = ctx();
      await fin.paymentProviders.updateSettings(ctxu, p.providerId, { verification: { mode: 'strict', windowMinutes: 30 }, security: { allowedCidrs: ['196.201.214.0/24'] }, operations: { qr_generate: { enabled: true, maxAmount: '5000' }, reversal: { enabled: true } } });
      const view = required((await fin.paymentProviders.list(companyId, null)).find((x) => x.id === p.providerId));
      expect(required(view.daraja).settings.verification).toMatchObject({ mode: 'strict', windowMinutes: 30 });
      expect(required(view.daraja).settings.security.allowedCidrs).toEqual(['196.201.214.0/24']);
      expect(required(view.daraja).operations.find((o) => o.code === 'qr_generate')).toMatchObject({ enabled: true, maxAmount: '5000', moneyOut: false });
      expect(required(view.daraja).hasInitiator).toBe(true);
      await expect(fin.paymentProviders.updateSettings(ctxu, p.providerId, { security: { allowedCidrs: ['not an address'] } })).rejects.toMatchObject({ code: 'CIDR_INVALID' });
    });
  });

  describe('money out', () => {
    let boss: string | undefined;
    let requester: string | undefined;
    const approver = async (label: string) => (await db.insert(schema.users).values({ email: `${label}-${randomUUID()}@payout.test`, passwordHash: 'x', name: label, role: 'manager' }).returning())[0].id;
    async function payoutWorkflow() {
      const { getContainer } = await import('@/server/di/container');
      const c = getContainer();
      boss ??= await approver('boss');
      requester ??= await approver('requester');
      await c.approvalConfig.saveProfile(companyId, { userId: boss, limits: [] }, { type: 'user', id: 'tester' }, { code: 'POLICY_CHANGE' });
      const wf = await c.approvalConfig.createWorkflow(companyId, { code: `W-${randomUUID().slice(0, 8)}`, name: 'Payout test', trigger: 'provider.disbursement' }, { type: 'user', id: 'tester' });
      await c.approvalConfig.saveDraft(companyId, wf.id, { conditions: { op: 'gte', field: 'amount', value: 1 }, steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: boss } }] } as never, { type: 'user', id: 'tester' });
      await c.approvalConfig.publish(companyId, wf.id, { type: 'user', id: 'tester' }, { code: 'POLICY_CHANGE' });
      return { c, wf };
    }
    const ask = (p: { providerId: string; methodId: string }, o: Record<string, unknown> = {}) =>
      engine.disbursements.request({ companyId, providerId: p.providerId, methodId: p.methodId, operation: 'b2c', input: { phone: '0712345678', amount: '500', commandId: 'BusinessPayment', remarks: 'Refund' }, requestedBy: requester ?? 'u', ...o } as never);
    const approveAll = async (c: Awaited<ReturnType<typeof payoutWorkflow>>['c'], id: string) => {
      const { withAfterCommit } = await import('@/server/kernel/after-commit');
      for (let i = 0; i < 5; i++) {
        const entry = (await c.approvals.forDocument(companyId, 'provider_operation', id)).flatMap((x) => x.entries).find((e) => e.status === 'open');
        if (!entry) return;
        await withAfterCommit(db, (tx) => c.approvals.approve(entry.id, required(boss), null, tx));
      }
    };
    const b2cCalls = () => fake.calls.filter((c) => c.path === '/mpesa/b2c/v3/paymentrequest');

    it('is off until switched on, and cannot be run directly even then', async () => {
      const p = await provider({ initiator: true });
      await expect(ask(p)).rejects.toMatchObject({ code: 'OPERATION_OFF' });
      await setSettings(p.providerId, { operations: { b2c: { enabled: true, maxAmount: '1000' } } });
      await expect(engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: 'b2c', input: { phone: '0712345678', amount: '500' } })).rejects.toMatchObject({ code: 'USE_REQUEST' });
      expect(b2cCalls()).toHaveLength(0);
    });

    it('refuses what is not allowed, in words, before anything is written down', async () => {
      const p = await provider({ initiator: true, settings: { operations: { b2c: { enabled: true, maxAmount: '1000' } }, dailyPayoutLimit: '1200' } });
      await expect(ask(p, { input: { phone: '0712345678', amount: '5', remarks: 'x1' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(ask(p, { input: { phone: 'abc', amount: '500', remarks: 'Refund' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(ask(p, { input: { phone: '0712345678', amount: '500.5', remarks: 'Refund' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(ask(p, { input: { phone: '0712345678', amount: '1500', remarks: 'Refund' } })).rejects.toMatchObject({ code: 'OVER_LIMIT' });
      const noInit = await provider({ settings: { operations: { b2c: { enabled: true } } } });
      await expect(ask(noInit)).rejects.toMatchObject({ code: 'NO_INITIATOR' });
      await expect(ask(p)).rejects.toMatchObject({ code: 'NO_APPROVAL_WORKFLOW' });
      expect(await db.select().from(schema.providerOperations).where(eq(schema.providerOperations.providerId, p.providerId))).toHaveLength(0);
    });

    it('is sent only after someone else approves it, once, and finished by the verified result', async () => {
      const p = await provider({ initiator: true, settings: { operations: { b2c: { enabled: true, maxAmount: '1000' } }, dailyPayoutLimit: '1200' } });
      const { c } = await payoutWorkflow();
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/mpesa/b2c/v3/paymentrequest', (b) => ({ json: { ConversationID: 'AG_CONV_1', OriginatorConversationID: b.OriginatorConversationID, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      const before = b2cCalls().length;
      const r = await ask(p);
      expect(r.status).toBe('pending_approval');
      expect(r.op.status).toBe('pending_approval');
      await engine.sweep();
      expect(b2cCalls().length).toBe(before); // waiting for approval: nothing leaves
      // the same limit counts what is already asked for
      await expect(ask(p, { input: { phone: '0712345678', amount: '800', remarks: 'Refund' } })).rejects.toMatchObject({ code: 'DAILY_LIMIT' });
      const { withAfterCommit } = await import('@/server/kernel/after-commit');
      const entry = required((await c.approvals.forDocument(companyId, 'provider_operation', r.op.id)).flatMap((x) => x.entries).find((e) => e.status === 'open'));
      await withAfterCommit(db, (tx) => c.approvals.approve(entry.id, required(boss), null, tx));
      const queued = (await engine.ops.get(r.op.id));
      expect(queued.status).toBe('queued');
      await engine.sweep();
      expect(b2cCalls().length).toBe(before + 1);
      const sent = required(b2cCalls().at(-1));
      expect(sent.body).toMatchObject({ Amount: '500', PartyB: '254712345678', CommandID: 'BusinessPayment', OriginatorConversationID: queued.originatorId });
      await engine.sweep();
      expect(b2cCalls().length).toBe(before + 1); // never sent twice
      expect((await engine.ops.get(r.op.id)).status).toBe('accepted');
      const result = (receipt: string | null) => ({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', OriginatorConversationID: queued.originatorId, ConversationID: 'AG_CONV_1', TransactionID: receipt ?? '', ResultParameters: { ResultParameter: has(receipt) ? [{ Key: 'TransactionReceipt', Value: receipt }, { Key: 'TransactionAmount', Value: 500 }] : [] } } });
      // an answer for a conversation that is not the one Safaricom gave us is refused
      const forged = await engine.daraja.completeFromResult(p.providerId, { Result: { ...result('QWE1234567').Result, ConversationID: 'AG_OTHER' } });
      expect(forged.matched).toBe(false);
      // success without a transaction number is held for a person, never counted as paid
      const held = await engine.daraja.completeFromResult(p.providerId, result(null));
      expect(held.op).toMatchObject({ status: 'in_doubt', failureCode: 'NO_RECEIPT' });
    });

    it('each payout is built to what Safaricom documents, and a payout is never re-sent after a network failure', async () => {
      const on = (code: string) => [code, { enabled: true }] as const;
      const p = await provider({ initiator: true, settings: { operations: Object.fromEntries([on('reversal'), on('b2b_paybill'), on('b2b_buygoods'), on('tax_remittance')]) } });
      const { c } = await payoutWorkflow();
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      for (const path of ['/mpesa/reversal/v1/request', '/mpesa/b2b/v1/paymentrequest', '/mpesa/b2b/v1/remittax']) {
        fake.on(path, () => ({ json: { ConversationID: `AG_${path.length}`, OriginatorConversationID: 'x', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      }
      const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
        ['reversal', { transactionId: 'NLJ7RT61SV', amount: '300', remarks: 'Wrong customer' }, '/mpesa/reversal/v1/request', { CommandID: 'TransactionReversal', TransactionID: 'NLJ7RT61SV', Amount: '300' }],
        ['b2b_paybill', { partyB: '888880', amount: '1200', accountReference: 'ACC-7', remarks: 'Rent' }, '/mpesa/b2b/v1/paymentrequest', { CommandID: 'BusinessPayBill', PartyB: '888880', Amount: '1200', AccountReference: 'ACC-7' }],
        ['b2b_buygoods', { partyB: '555550', amount: '90', accountReference: 'POS', remarks: 'Stock' }, '/mpesa/b2b/v1/paymentrequest', { CommandID: 'BusinessBuyGoods', PartyB: '555550' }],
        ['tax_remittance', { prn: 'KRA12345678', amount: '4000', remarks: 'PAYE' }, '/mpesa/b2b/v1/remittax', { CommandID: 'PayTaxToKRA', PartyB: '572572', AccountReference: 'KRA12345678', Amount: '4000' }],
      ];
      for (const [operation, input, path, expected] of cases) {
        const r = await ask(p, { operation, input });
        await approveAll(c, r.op.id);
        await engine.sweep();
        const sent = required(fake.calls.filter((x) => x.path === path).at(-1));
        expect(sent.body, operation).toMatchObject(expected);
        expect(JSON.stringify(sent.body)).not.toContain('Init#Pass1');
        expect(typeof (sent.body as { SecurityCredential?: unknown }).SecurityCredential).toBe('string');
      }
      // a connection that drops mid-payout leaves it for a person: it is not sent a second time
      const r = await ask(p, { operation: 'reversal', input: { transactionId: 'NLJ7RT61XY', amount: '10', remarks: 'Dropped link' } });
      fake.down = true;
      await approveAll(c, r.op.id);
      const attempts = () => fake.calls.filter((x) => x.path === '/mpesa/reversal/v1/request').length;
      const n = attempts();
      await engine.sweep();
      await engine.sweep();
      fake.down = false;
      await engine.sweep();
      expect(attempts() - n).toBeLessThanOrEqual(1);
      expect((await engine.ops.get(r.op.id)).status).not.toBe('succeeded');
    });

    it('B2C Account Top Up and Pochi la Biashara are built to what Safaricom documents; a Pochi payout is safe to send again, a top-up is not', async () => {
      const on = (code: string) => [code, { enabled: true }] as const;
      const p = await provider({ initiator: true, settings: { operations: Object.fromEntries([on('b2c_topup'), on('b2pochi')]) } });
      const { c } = await payoutWorkflow();
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      for (const path of ['/mpesa/b2b/v1/paymentrequest', '/mpesa/b2pochi/v1/paymentrequest']) {
        fake.on(path, (b) => ({ json: { ConversationID: `AG_TOP_${path.length}`, OriginatorConversationID: b.OriginatorConversationID ?? 'x', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      }
      // The top-up
      const top = await ask(p, { operation: 'b2c_topup', input: { partyB: '600000', amount: '239', accountReference: '353353', requester: '0708374149', remarks: 'Float for refunds' } });
      await approveAll(c, top.op.id);
      await engine.sweep();
      const topSent = required(fake.calls.filter((x) => x.path === '/mpesa/b2b/v1/paymentrequest').at(-1));
      expect(topSent.body).toMatchObject({ CommandID: 'BusinessPayToBulk', SenderIdentifierType: '4', RecieverIdentifierType: '4', Amount: '239', PartyB: '600000', AccountReference: '353353', Requester: '254708374149', Remarks: 'Float for refunds' });
      expect(typeof (topSent.body as { SecurityCredential?: unknown }).SecurityCredential).toBe('string');
      expect(JSON.stringify(topSent.body)).not.toContain('Init#Pass1');
      expect(await engine.ops.get(top.op.id)).toMatchObject({ status: 'accepted' });
      // A shortcode that is not a shortcode is refused before anything is written down.
      await expect(ask(p, { operation: 'b2c_topup', input: { partyB: '12', amount: '10', accountReference: 'x', remarks: 'bad' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      // Pochi la Biashara
      const pochi = await ask(p, { operation: 'b2pochi', input: { phone: '0705912645', amount: '11', remarks: 'Cashback', occasion: 'October' } });
      await approveAll(c, pochi.op.id);
      await engine.sweep();
      const sent = required(fake.calls.filter((x) => x.path === '/mpesa/b2pochi/v1/paymentrequest').at(-1));
      const now = await engine.ops.get(pochi.op.id);
      expect(sent.body).toMatchObject({ OriginatorConversationID: now.originatorId, InitiatorName: 'apiuser', CommandID: 'BusinessPayToPochi', Amount: '11', PartyB: '254705912645', Remarks: 'Cashback', Occassion: 'October' });
      expect(now).toMatchObject({ status: 'accepted' });
      // The result arrives with the receipt, is held until Safaricom's own record agrees, and names the Pochi receipt.
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const receipt = rc();
      await engine.ingestHook({ providerId: p.providerId, kind: 'result', secret, rawText: JSON.stringify({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', OriginatorConversationID: now.originatorId, ConversationID: now.conversationId, TransactionID: receipt, ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: 11 }, { Key: 'TransactionReceipt', Value: receipt }, { Key: 'ReceiverPartyPublicName', Value: '254705912645 - A CUSTOMER' }, { Key: 'B2CRecipientIsRegisteredCustomer', Value: 'Y' }] } } }), headers: {}, sourceIp: '196.201.214.200', https: true, method: 'POST' });
      expect(await engine.ops.get(pochi.op.id)).toMatchObject({ platformReference: receipt });
    });

    it('M-Pesa Ratiba: a standing order is asked for, and the customer\'s answer settles it by the reference Safaricom gave', async () => {
      const p = await provider({ settings: { operations: { ratiba_create: { enabled: true } } } });
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      let n = 0;
      fake.on('/standingorder/v1/createStandingOrderExternal', () => ({ json: { ResponseHeader: { responseRefID: `ratiba-ref-${run}-${++n}`, responseCode: '200', responseDescription: 'Request accepted for processing', ResultDesc: 'The service request is processed successfully.' }, ResponseBody: { responseDescription: 'Request accepted for processing', responseCode: '200' } } }));
      const day = (ahead: number) => new Date(Date.now() + ahead * 86_400_000).toISOString().slice(0, 10);
      const input = { standingOrderName: `Rent ${run}`, phone: '0708374149', amount: '4500', frequency: '4', startDate: day(1), endDate: day(365), receiverType: '4', accountReference: 'RENT7', transactionDesc: 'Rent' };
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const hook = (body: unknown, s = secret) => engine.ingestHook({ providerId: p.providerId, kind: 'ratiba', secret: s, rawText: JSON.stringify(body), headers: {}, sourceIp: '196.201.214.200', https: true, method: 'POST' } as never);

      const ok = (await engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: 'ratiba_create', input })).op;
      const sent = required(fake.calls.filter((x) => x.path === '/standingorder/v1/createStandingOrderExternal').at(-1));
      expect(sent.body).toMatchObject({ StandingOrderName: `Rent ${run}`, StartDate: day(1).replaceAll('-', ''), EndDate: day(365).replaceAll('-', ''), BusinessShortCode: '174379', TransactionType: 'Standing Order Customer Pay Bill', ReceiverPartyIdentifierType: '4', Amount: '4500', PartyA: '254708374149', AccountReference: 'RENT7', TransactionDesc: 'Rent', Frequency: '4' });
      expect((sent.body as { CallBackURL: string }).CallBackURL).toContain(`/api/hooks/pay/${p.providerId}/ratiba/`);
      expect(ok).toMatchObject({ status: 'accepted' });
      const refId = required(ok.conversationId);
      // An answer for a standing order that is not ours is kept as unmatched.
      expect((await hook({ responseHeader: { responseRefID: 'someone-else', responseCode: '0' }, responseBody: { responseData: [{ name: 'Status', value: 'OKAY' }] } })).httpStatus).toBe(200);
      expect(await engine.ops.get(ok.id)).toMatchObject({ status: 'accepted' });
      // A wrong secret is just "not found".
      expect((await hook({ responseHeader: { responseRefID: refId } }, 'wrong-secret')).httpStatus).toBe(404);
      // The customer approved: the order stands, under Safaricom's id for it.
      await hook({ responseHeader: { responseRefID: refId, requestRefID: refId, responseCode: '0', responseDescription: 'The service request is processed successfully' }, responseBody: { responseData: [{ name: 'TransactionID', value: 'SC8F2IQMH5' }, { name: 'responseCode', value: '0' }, { name: 'Status', value: 'OKAY' }, { name: 'Msisdn', value: '254******867' }] } });
      expect(await engine.ops.get(ok.id)).toMatchObject({ status: 'succeeded', platformReference: 'SC8F2IQMH5' });
      // The same answer again changes nothing.
      await hook({ responseHeader: { responseRefID: refId, responseCode: '1037' }, responseBody: { responseData: [{ name: 'Status', value: 'ERROR' }] } });
      expect((await engine.ops.get(ok.id)).status).toBe('succeeded');

      // A customer who does not approve (a timeout on the phone): failed, with Safaricom's words and capital-letter keys.
      const declined = (await engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: 'ratiba_create', input: { ...input, standingOrderName: `Declined ${run}` } })).op;
      await hook({ ResponseHeader: { responseRefID: required(declined.conversationId), requestRefID: 'x', responseCode: '1037', responseDescription: 'Error' }, ResponseBody: { ResponseData: [{ Name: 'TransactionID', Value: '0000000000' }, { Name: 'responseCode', Value: '1037' }, { Name: 'Status', Value: 'ERROR' }, { Name: 'Msisdn', Value: '*********149' }] } });
      expect(await engine.ops.get(declined.id)).toMatchObject({ status: 'failed', failureCode: '1037' });

      // Dates that make no sense are refused before anything is sent.
      const calls = fake.calls.filter((x) => x.path === '/standingorder/v1/createStandingOrderExternal').length;
      const backwards = (await engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: 'ratiba_create', input: { ...input, standingOrderName: `Back ${run}`, startDate: day(30), endDate: day(5) } })).op;
      expect(backwards).toMatchObject({ status: 'failed', failureCode: 'DATES_INVALID' });
      expect(fake.calls.filter((x) => x.path === '/standingorder/v1/createStandingOrderExternal')).toHaveLength(calls);
      // A till is paid under its own type.
      await engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: 'ratiba_create', input: { ...input, standingOrderName: `Till ${run}`, receiverType: '2' } });
      expect(required(fake.calls.filter((x) => x.path === '/standingorder/v1/createStandingOrderExternal').at(-1)).body).toMatchObject({ TransactionType: 'Standing Order Customer Pay Marchant', ReceiverPartyIdentifierType: '2' });
    });

    it('B2B Express Checkout: a failure is recorded; a success is only a claim, claimed under its M-Pesa code, and credited once Safaricom confirms it', async () => {
      const p = await provider({ initiator: true, autoAllocate: true, channel: '600638', settings: { operations: { b2b_express: { enabled: true } } } });
      const number = `E${run}${++seq}`;
      const [cust] = await db.insert(schema.customers).values({ companyId, number, name: `Express ${number}`, phone: '0711000222', accountType: 'cash', creditLimit: '0' }).returning();
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/v1/ussdpush/get-msisdn', (b) => ({ json: { code: '0', status: 'USSD Initiated Successfully', requestRefID: b.RequestRefID } }));
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: 'AG_EXP', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      const start = async (ref: string) => (await engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: 'b2b_express', input: { primaryShortCode: '555550', amount: '70', paymentRef: ref, partnerName: 'Shop' } })).op;
      const hook = async (op: { originatorId: string | null }, body: Record<string, unknown>) => {
        const sentBody = required(fake.calls.filter((x) => x.path === '/v1/ussdpush/get-msisdn').at(-1)).body as { callbackUrl: string };
        const token = required(sentBody.callbackUrl.split('/').pop());
        return await engine.ingestHook({ providerId: p.providerId, kind: 'express', secret: token, rawText: JSON.stringify({ requestId: op.originatorId, ...body }), headers: {}, sourceIp: '196.201.214.200', https: true } as never);
      };
      const bad = await start('INV-8');
      expect((await hook(bad, { resultCode: '4001', resultDesc: 'Declined', status: 'FAILED' })).httpStatus).toBe(200);
      expect(await engine.ops.get(bad.id)).toMatchObject({ status: 'failed', failureCode: '4001' });
      expect(await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.accountReference, 'INV-8'))).toHaveLength(0);

      const good = await start(number);
      const receipt = rc();
      await hook(good, { resultCode: '0', status: 'SUCCESS', transactionId: receipt, amount: '70', paymentReference: number });
      expect(await engine.ops.get(good.id)).toMatchObject({ status: 'succeeded', platformReference: receipt });
      // claimed, not credited: nobody has asked Safaricom
      let tx = (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, receipt)))[0];
      expect(tx).toMatchObject({ kind: 'b2b_express', state: 'claimed', amount: '70.0000', accountReference: number, methodId: p.methodId, shortcode: '600638' });
      expect(await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.externalReference, receipt))).toHaveLength(0);
      const ev = await db.select().from(schema.providerEvents).where(eq(schema.providerEvents.platformReference, receipt));
      expect(ev[0]).toMatchObject({ state: 'awaiting_verification' });
      // the same callback again counts nothing twice
      await hook(good, { resultCode: '0', status: 'SUCCESS', transactionId: receipt, amount: '70', paymentReference: number });
      expect(await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, receipt))).toHaveLength(1);
      // Safaricom confirms it: it lands on the customer
      expect((await engine.c2b.verify(tx.id)).state).toBe('waiting');
      const check = (await engine.ops.bySubject('provider_transaction', tx.id, 'transaction_status'))[0];
      const secret = await engine.contexts.callbackSecret(p.providerId);
      await engine.ingestHook({ providerId: p.providerId, kind: 'result', secret, rawText: JSON.stringify({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: check.originatorId, ConversationID: 'AG_EXP', ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: receipt }, { Key: 'Amount', Value: 70 }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'CreditPartyName', Value: '600638 - Acme' }] } } }), headers: {}, sourceIp: null, https: true, method: 'POST' });
      expect((await engine.c2b.verify(tx.id)).state).toBe('consumed');
      tx = (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, receipt)))[0];
      const [rec] = await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.id, required(tx.consumedId)));
      expect(rec).toMatchObject({ customerId: cust.id, status: 'posted', amount: '70.00', externalReference: receipt });
    });

    it('a payout counts as paid only when Safaricom\'s own record of the transaction agrees', async () => {
      const p = await provider({ initiator: true, settings: { operations: { b2c: { enabled: true } } } });
      const { c } = await payoutWorkflow();
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/mpesa/b2c/v3/paymentrequest', (b) => ({ json: { ConversationID: `AG_${readText(b.Amount)}`, OriginatorConversationID: b.OriginatorConversationID, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { ConversationID: 'AG_ST', OriginatorConversationID: 'x', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      const resultUrl = () => (required(fake.calls.filter((x) => x.path === '/mpesa/b2c/v3/paymentrequest').at(-1)).body as { ResultURL: string }).ResultURL;
      const secret = () => required(resultUrl().split('/').pop());
      const run = async (amount: string, receipt: string, statusAmount: number) => {
        const r = await ask(p, { input: { phone: '0712345678', amount, commandId: 'BusinessPayment', remarks: 'Payout check' } });
        await approveAll(c, r.op.id);
        await engine.sweep();
        const op = (await engine.ops.get(r.op.id));
        const hook = (kind: 'result', body: unknown) => engine.ingestHook({ providerId: p.providerId, kind, secret: secret(), rawText: JSON.stringify(body), headers: {}, sourceIp: null, https: true, method: 'POST' });
        await hook('result', { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: op.originatorId, ConversationID: op.conversationId, TransactionID: receipt, ResultParameters: { ResultParameter: [{ Key: 'TransactionReceipt', Value: receipt }] } } });
        // reported as done, but not counted until the check comes back
        expect((await engine.ops.get(op.id)).status).toBe('accepted');
        const [check] = await engine.ops.bySubject('provider_operation', op.id, 'transaction_status');
        expect(check).toBeTruthy();
        await hook('result', { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: check.originatorId, ConversationID: check.conversationId, ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: receipt }, { Key: 'Amount', Value: statusAmount }, { Key: 'TransactionStatus', Value: 'Completed' }] } } });
        return (await engine.ops.get(op.id));
      };
      expect(await run('500', 'PAYOK00001', 500)).toMatchObject({ status: 'succeeded', platformReference: 'PAYOK00001' });
      expect(await run('600', 'PAYBAD0001', 6)).toMatchObject({ status: 'in_doubt', failureCode: 'STATUS_AMOUNT_MISMATCH' });
    });

    it('a payout left in doubt can be checked again with Safaricom, or closed by a person who looked at the statement', async () => {
      const p = await provider({ initiator: true, settings: { operations: { b2c: { enabled: true } } } });
      const { c } = await payoutWorkflow();
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/mpesa/b2c/v3/paymentrequest', (b) => ({ json: { ConversationID: `AG_${readText(b.Amount)}`, OriginatorConversationID: b.OriginatorConversationID, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { ConversationID: 'AG_ST', OriginatorConversationID: 'x', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      const secret = () => required((required(fake.calls.filter((x) => x.path === '/mpesa/b2c/v3/paymentrequest').at(-1)).body as { ResultURL: string }).ResultURL.split('/').pop());
      const hook = (body: unknown) => engine.ingestHook({ providerId: p.providerId, kind: 'result', secret: secret(), rawText: JSON.stringify(body), headers: {}, sourceIp: null, https: true, method: 'POST' });
      const statusResult = (check: { originatorId: string | null; conversationId: string | null }, receipt: string, amount: number) =>
        ({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: check.originatorId, ConversationID: check.conversationId, ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: receipt }, { Key: 'Amount', Value: amount }, { Key: 'TransactionStatus', Value: 'Completed' }] } } });
      // a payout whose record disagrees on the amount is held in doubt
      const r = await ask(p, { input: { phone: '0712345678', amount: '700', commandId: 'BusinessPayment', remarks: 'Doubt' } });
      await approveAll(c, r.op.id);
      await engine.sweep();
      const op = await engine.ops.get(r.op.id);
      await hook({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: op.originatorId, ConversationID: op.conversationId, TransactionID: 'DOUBT00001', ResultParameters: { ResultParameter: [{ Key: 'TransactionReceipt', Value: 'DOUBT00001' }] } } });
      const [first] = await engine.ops.bySubject('provider_operation', op.id, 'transaction_status');
      await hook(statusResult(first, 'DOUBT00001', 7));
      expect(await engine.ops.get(op.id)).toMatchObject({ status: 'in_doubt', failureCode: 'STATUS_AMOUNT_MISMATCH' });
      // asking again is a new question; this time Safaricom's record agrees
      expect(await engine.recheckPayout(op.id)).toEqual({ ok: true });
      const checks = await engine.ops.bySubject('provider_operation', op.id, 'transaction_status');
      expect(checks).toHaveLength(2);
      await hook(statusResult(required(checks.at(-1)), 'DOUBT00001', 700));
      expect(await engine.ops.get(op.id)).toMatchObject({ status: 'succeeded', platformReference: 'DOUBT00001' });
      // a paid payout cannot be rechecked or closed
      expect(await engine.recheckPayout(op.id)).toMatchObject({ ok: false });
      expect(await engine.closeDoubtfulPayout({ opId: op.id, userId: 'u', reason: 'the statement shows nothing at all', moneyLeft: false })).toMatchObject({ ok: false });

      // a payout that never got a receipt cannot be looked up: a person closes it, and the closing is kept with their name
      const silent = await ask(p, { input: { phone: '0712345678', amount: '710', commandId: 'BusinessPayment', remarks: 'Silent' } });
      await approveAll(c, silent.op.id);
      await engine.sweep();
      await db.update(schema.providerOperations).set({ status: 'in_doubt', failureCode: 'NO_RESULT', failureReason: 'No answer arrived.' }).where(eq(schema.providerOperations.id, silent.op.id));
      expect(await engine.recheckPayout(silent.op.id)).toMatchObject({ ok: false });
      expect(await engine.closeDoubtfulPayout({ opId: silent.op.id, userId: 'u1', reason: 'too short', moneyLeft: false })).toMatchObject({ ok: false });
      expect(await engine.closeDoubtfulPayout({ opId: silent.op.id, userId: 'u1', reason: 'the statement shows no debit for 710', moneyLeft: false })).toEqual({ ok: true });
      const closed = await engine.ops.get(silent.op.id);
      expect(closed).toMatchObject({ status: 'failed', failureCode: 'CLOSED_NOT_PAID' });
      expect(closed.result).toMatchObject({ closedBy: 'u1', moneyLeft: false });
    });

    it('a rejected payout is never sent', async () => {
      const p = await provider({ initiator: true, settings: { operations: { b2c: { enabled: true } } } });
      const { c } = await payoutWorkflow();
      const before = b2cCalls().length;
      const r = await ask(p);
      const { withAfterCommit } = await import('@/server/kernel/after-commit');
      const entry = required((await c.approvals.forDocument(companyId, 'provider_operation', r.op.id)).flatMap((x) => x.entries).find((e) => e.status === 'open'));
      await withAfterCommit(db, (tx) => c.approvals.reject(entry.id, required(boss), { reasonCode: 'OTHER', comment: 'No' }, tx));
      expect((await engine.ops.get(r.op.id)).status).toBe('rejected');
      await engine.sweep();
      expect(b2cCalls().length).toBe(before);
    });
  });

  describe('Bill Manager', () => {
    it('builds sign-up, single and bulk invoices and cancellations as documented, and reads the platform\'s answer', async () => {
      const p = await provider({ initiator: false });
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      const answer = (code: string) => () => ({ json: { rescode: code, resmsg: code === '200' ? 'Success' : 'Invalid request', Status_Message: '' } });
      for (const path of ['optin', 'single-invoicing', 'bulk-invoicing', 'cancel-single-invoice', 'cancel-bulk-invoices']) fake.on(`/v1/billmanager-invoice/${path}`, answer('200'));
      const last = (path: string) => required(fake.calls.filter((x) => x.path === `/v1/billmanager-invoice/${path}`).at(-1)).body as Record<string, unknown> & unknown[];
      const run = (operation: string, input: Record<string, unknown>) => engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: operation as never, input });
      expect((await run('bill_optin', { email: 'a@b.co', officialContact: '0712345678', sendReminders: '1' })).op.status).toBe('succeeded');
      expect(last('optin')).toMatchObject({ shortcode: '174379', email: 'a@b.co', sendReminders: '1' });
      expect(String(last('optin').callbackurl)).toMatch(/\/api\/hooks\/pay\/.+\/bill\//);
      const inv = { externalReference: 'INV-1', billedFullName: 'Jane', billedPhoneNumber: '0712345678', billedPeriod: 'October 2026', invoiceName: 'Rent', dueDate: '2026-10-31', accountReference: 'C0001', amount: '1500' };
      expect((await run('bill_invoice', inv)).op.status).toBe('succeeded');
      expect(last('single-invoicing')).toMatchObject({ externalReference: 'INV-1', billedPhoneNumber: '254712345678', amount: '1500', dueDate: '2026-10-31 00:00:00.00' });
      expect((await run('bill_invoice_bulk', { invoices: [inv, { ...inv, externalReference: 'INV-2' }] })).op.status).toBe('succeeded');
      expect(last('bulk-invoicing')).toHaveLength(2);
      expect((last('bulk-invoicing') as unknown as Record<string, unknown>[])[1]).toMatchObject({ billedPhoneNumber: '254712345678', dueDate: '2026-10-31 00:00:00.00', invoiceItems: [{ itemName: 'Rent', amount: '1500' }] });
      expect((await run('bill_cancel', { externalReference: 'INV-1' })).op.status).toBe('succeeded');
      expect((await run('bill_cancel_bulk', { references: ['INV-1', 'INV-2'] })).op.status).toBe('succeeded');
      expect(last('cancel-bulk-invoices')).toEqual([{ externalReference: 'INV-1' }, { externalReference: 'INV-2' }]);
      fake.on('/v1/billmanager-invoice/single-invoicing', answer('400'));
      const refused = (await run('bill_invoice', { ...inv, externalReference: 'INV-3' })).op;
      expect(refused).toMatchObject({ status: 'failed', failureCode: '400' });
    });
  });

  describe('Bill Manager invoices, followed to the receipt', () => {
    const hook = (p: { providerId: string }, kind: 'c2b-confirm' | 'result' | 'bill', body: unknown, secret: string) =>
      engine.ingestHook({ providerId: p.providerId, kind, secret, rawText: JSON.stringify(body), headers: {}, sourceIp: '196.201.214.200', https: true, method: 'POST' });
    const c2bBody = (id: string, ref: string, amount: string) => ({ TransactionType: 'Pay Bill', TransID: id, TransTime: '20260113123045', TransAmount: amount, BusinessShortCode: '600638', BillRefNumber: ref, InvoiceNumber: '', OrgAccountBalance: '9999.00', ThirdPartyTransID: '', MSISDN: '2547 ***** 126', FirstName: 'Jane', MiddleName: '', LastName: 'Doe' });
    const billBody = (id: string, ref: string, amount: string) => ({ transactionId: id, paidAmount: amount, msisdn: '2547 ***** 126', dateCreated: '2026-01-13', accountReference: ref, shortCode: '600638' });
    const txOf = async (ref: string) => (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, ref)))[0];
    const invoice = (reference: string, accountReference: string, amount: string, dueDate = '2026-10-31') => ({ reference, accountReference, billedName: 'Jane Doe', phone: '0712345678', invoiceName: 'Rent', period: 'October 2026', amount, dueDate });
    const invoiceRow = async (providerId: string, reference: string) => (await db.select().from(schema.billInvoices).where(and(eq(schema.billInvoices.providerId, providerId), eq(schema.billInvoices.reference, reference))))[0];

    /** A payment announced by the paybill, checked by Safaricom, and put on the customer. */
    async function paid(p: { providerId: string }, secret: string, ref: string, amount: string, via: 'c2b-confirm' | 'bill' = 'c2b-confirm') {
      const id = rc();
      await hook(p, via, via === 'bill' ? billBody(id, ref, amount) : c2bBody(id, ref, amount), secret);
      const tx = await txOf(id);
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: `AG_${id}`, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      await engine.c2b.verify(tx.id);
      const check = (await engine.ops.bySubject('provider_transaction', tx.id, 'transaction_status'))[0];
      await hook(p, 'result', { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: check.originatorId, ConversationID: `AG_${id}`, ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: id }, { Key: 'Amount', Value: Number(amount) }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'CreditPartyName', Value: '600638 - Acme' }] } } }, secret);
      await engine.c2b.verify(tx.id);
      return { id, tx: await txOf(id) };
    }
    const ack = () => fake.calls.filter((c) => c.path === '/v1/billmanager-invoice/reconciliation');

    it('an invoice is written down when asked for, becomes sent, is paid by a confirmed payment to its account number, and Bill Manager is told', async () => {
      const p = await provider({ channel: '600638', initiator: true, autoAllocate: true });
      const number = `B${run}${++seq}`;
      await db.insert(schema.customers).values({ companyId, number, name: `Biller ${number}`, phone: '0711000333', accountType: 'cash', creditLimit: '0' });
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/v1/billmanager-invoice/reconciliation', () => ({ json: { rescode: '200', resmsg: 'Success', Status_Message: '' } }));
      const a = invoice(`INV-A-${number}`, number, '250.00', '2026-10-20');
      const b = invoice(`INV-B-${number}`, number, '400.00', '2026-10-31');
      await engine.bills.record({ companyId, providerId: p.providerId, methodId: p.methodId, requestedBy: 'tester', invoices: [a, b] });
      expect((await invoiceRow(p.providerId, a.reference)).status).toBe('requested');
      expect(await engine.bills.existing(p.providerId, [a.reference, 'NOPE'])).toEqual(new Map([[a.reference, 'requested']]));
      await engine.bills.sent(p.providerId, [a.reference, b.reference], { id: null, status: 'succeeded', failureReason: null });
      const sent = await invoiceRow(p.providerId, a.reference);
      expect(sent).toMatchObject({ status: 'sent', paidAmount: '0.00' });
      expect(sent.phoneMasked).toContain('•');
      expect(typeof sent.customerId).toBe('string');
      const secret = await engine.contexts.callbackSecret(p.providerId);

      // 250 is exactly invoice A: it is paid, the customer's receipt exists, and Bill Manager is told
      const first = await paid(p, secret, number, '250.00');
      expect(first.tx).toMatchObject({ state: 'consumed', consumedType: 'customer_receipt' });
      expect(await invoiceRow(p.providerId, a.reference)).toMatchObject({ status: 'paid', paidAmount: '250.00', lastTransactionId: first.tx.id });
      expect((await invoiceRow(p.providerId, a.reference)).acknowledgedAt).not.toBeNull();
      expect(await invoiceRow(p.providerId, b.reference)).toMatchObject({ status: 'sent', paidAmount: '0.00' });
      expect(ack()).toHaveLength(1);
      expect(ack()[0].body).toMatchObject({ transactionId: first.id, externalReference: a.reference, accountReference: number, paidAmount: '250.00' });

      // telling the engine again changes nothing and tells Bill Manager nothing more
      await engine.bills.paymentPlaced(first.tx);
      expect(await invoiceRow(p.providerId, a.reference)).toMatchObject({ status: 'paid', paidAmount: '250.00' });
      expect(ack()).toHaveLength(1);

      // a smaller payment part pays the next one; the rest pays it off
      await paid(p, secret, number, '100.00');
      expect(await invoiceRow(p.providerId, b.reference)).toMatchObject({ status: 'part_paid', paidAmount: '100.00' });
      await paid(p, secret, number, '300.00');
      expect(await invoiceRow(p.providerId, b.reference)).toMatchObject({ status: 'paid', paidAmount: '400.00' });
      expect(ack()).toHaveLength(3);

      // paid ones cannot be cancelled, and nothing else is touched by the refusal
      const c = await engine.bills.cancellable(p.providerId, [a.reference, b.reference, 'UNKNOWN-1']);
      expect(c.refused.map((r) => r.reference)).toEqual([a.reference, b.reference]);
      expect(c.ok).toEqual(['UNKNOWN-1']);
    });

    it('a payment to an account number with no open invoice settles none; a payment of the wrong size settles the oldest', async () => {
      const p = await provider({ channel: '600638', initiator: true, autoAllocate: true });
      const number = `N${run}${++seq}`;
      await db.insert(schema.customers).values({ companyId, number, name: `Nobody ${number}`, phone: '0711000444', accountType: 'cash', creditLimit: '0' });
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/v1/billmanager-invoice/reconciliation', () => ({ json: { rescode: '200', resmsg: 'Success', Status_Message: '' } }));
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const none = await paid(p, secret, number, '80.00');
      expect(none.tx.state).toBe('consumed');
      expect(await db.select().from(schema.billInvoices).where(eq(schema.billInvoices.providerId, p.providerId))).toHaveLength(0);
      const old = invoice(`OLD-${number}`, number, '500.00', '2026-09-01');
      const young = invoice(`YNG-${number}`, number, '600.00', '2026-12-01');
      await engine.bills.record({ companyId, providerId: p.providerId, methodId: p.methodId, requestedBy: 'tester', invoices: [young, old] });
      await engine.bills.sent(p.providerId, [old.reference, young.reference], { id: null, status: 'succeeded', failureReason: null });
      await paid(p, secret, number, '120.00');
      expect(await invoiceRow(p.providerId, old.reference)).toMatchObject({ status: 'part_paid', paidAmount: '120.00' });
      expect(await invoiceRow(p.providerId, young.reference)).toMatchObject({ status: 'sent' });
      expect((await engine.bills.overdue(companyId, '2026-10-17')).map((i) => i.reference)).toContain(old.reference);
    });

    it('a failed acknowledgement does not undo the payment, and says why on the invoice', async () => {
      const p = await provider({ channel: '600638', initiator: true, autoAllocate: true });
      const number = `K${run}${++seq}`;
      await db.insert(schema.customers).values({ companyId, number, name: `Ack ${number}`, phone: '0711000555', accountType: 'cash', creditLimit: '0' });
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/v1/billmanager-invoice/reconciliation', () => ({ json: { rescode: '500', resmsg: 'Bill Manager is not set up for this paybill', Status_Message: '' } }));
      const inv = invoice(`ACK-${number}`, number, '90.00');
      await engine.bills.record({ companyId, providerId: p.providerId, methodId: p.methodId, requestedBy: 'tester', invoices: [inv] });
      await engine.bills.sent(p.providerId, [inv.reference], { id: null, status: 'succeeded', failureReason: null });
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const out = await paid(p, secret, number, '90.00');
      expect(out.tx.state).toBe('consumed');
      expect(await invoiceRow(p.providerId, inv.reference)).toMatchObject({ status: 'paid', acknowledgedAt: null });
      expect((await invoiceRow(p.providerId, inv.reference)).ackError).toContain('not set up');
    });

    it('a Bill Manager notice is a claim: checked with Safaricom first, and counted once with the paybill\'s own announcement', async () => {
      const p = await provider({ channel: '600638', initiator: true, autoAllocate: true });
      const number = `M${run}${++seq}`;
      await db.insert(schema.customers).values({ companyId, number, name: `Notice ${number}`, phone: '0711000666', accountType: 'cash', creditLimit: '0' });
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/v1/billmanager-invoice/reconciliation', () => ({ json: { rescode: '200', resmsg: 'Success', Status_Message: '' } }));
      const inv = invoice(`NTC-${number}`, number, '55.00');
      await engine.bills.record({ companyId, providerId: p.providerId, methodId: p.methodId, requestedBy: 'tester', invoices: [inv] });
      await engine.bills.sent(p.providerId, [inv.reference], { id: null, status: 'succeeded', failureReason: null });
      const secret = await engine.contexts.callbackSecret(p.providerId);
      const id = rc();
      await hook(p, 'bill', billBody(id, number, '55.00'), secret);
      let tx = await txOf(id);
      expect(tx).toMatchObject({ kind: 'bill', state: 'claimed', amount: '55.0000', accountReference: number });
      // nothing is credited from the notice alone
      expect(await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.externalReference, id))).toHaveLength(0);
      expect(await invoiceRow(p.providerId, inv.reference)).toMatchObject({ status: 'sent' });
      // the paybill announces the same payment: it is the same transaction, counted once
      await hook(p, 'c2b-confirm', c2bBody(id, number, '55.00'), secret);
      expect(await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.platformReference, id))).toHaveLength(1);
      fake.on('/mpesa/transactionstatus/v1/query', () => ({ json: { OriginatorConversationID: 'x', ConversationID: `AG_${id}`, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } }));
      await engine.c2b.verify(tx.id);
      const check = (await engine.ops.bySubject('provider_transaction', tx.id, 'transaction_status'))[0];
      await hook(p, 'result', { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: check.originatorId, ConversationID: `AG_${id}`, ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: id }, { Key: 'Amount', Value: 55 }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'CreditPartyName', Value: '600638 - Acme' }] } } }, secret);
      await engine.c2b.verify(tx.id);
      tx = await txOf(id);
      expect(tx).toMatchObject({ state: 'consumed', consumedType: 'customer_receipt' });
      expect(await invoiceRow(p.providerId, inv.reference)).toMatchObject({ status: 'paid', paidAmount: '55.00' });
      expect(await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.externalReference, id))).toHaveLength(1);
      // a notice that is not a payment is only kept
      const odd = await hook(p, 'bill', { something: 'else' }, secret);
      expect(odd.httpStatus).toBe(200);
    });

    it('a repeated invoice number is refused unless the first was refused; a refused one is made again', async () => {
      const p = await provider({ channel: '600638' });
      const inv = invoice(`DUP-${run}${++seq}`, 'ACC1', '10.00');
      await engine.bills.record({ companyId, providerId: p.providerId, methodId: p.methodId, requestedBy: 'tester', invoices: [inv] });
      await engine.bills.sent(p.providerId, [inv.reference], { id: null, status: 'failed', failureReason: 'Invalid phone number' });
      expect(await invoiceRow(p.providerId, inv.reference)).toMatchObject({ status: 'failed', failureReason: 'Invalid phone number' });
      await engine.bills.record({ companyId, providerId: p.providerId, methodId: p.methodId, requestedBy: 'tester', invoices: [inv] });
      expect(await invoiceRow(p.providerId, inv.reference)).toMatchObject({ status: 'requested', failureReason: null });
      await engine.bills.sent(p.providerId, [inv.reference], { id: null, status: 'succeeded', failureReason: null });
      // sent now: a second try to record it leaves it alone
      await engine.bills.record({ companyId, providerId: p.providerId, methodId: p.methodId, requestedBy: 'tester', invoices: [{ ...inv, amount: '99.00' }] });
      expect(await invoiceRow(p.providerId, inv.reference)).toMatchObject({ status: 'sent', amount: '10.00' });
      fake.on('/oauth/v1/generate', () => ({ json: { access_token: 'tok', expires_in: '3599' } }));
      fake.on('/v1/billmanager-invoice/cancel-single-invoice', () => ({ json: { rescode: '200', resmsg: 'Success', Status_Message: '' } }));
      const { op } = await engine.daraja.start({ providerId: p.providerId, methodId: p.methodId, operation: 'bill_cancel', input: { externalReference: inv.reference } });
      expect(await engine.bills.cancelled(p.providerId, [inv.reference], op)).toBe(1);
      expect((await invoiceRow(p.providerId, inv.reference)).status).toBe('cancelled');
      // kept for ever
      await expect(db.delete(schema.billInvoices).where(eq(schema.billInvoices.providerId, p.providerId))).rejects.toThrow();
      await expect(db.update(schema.billInvoices).set({ amount: '1.00' }).where(eq(schema.billInvoices.providerId, p.providerId))).rejects.toThrow();
    });

    it('lists invoices a page at a time, by state or by a word in the number, name or account', async () => {
      const p = await provider({ channel: '600638' });
      const word = `PG${run}${++seq}`;
      await engine.bills.record({ companyId, providerId: p.providerId, methodId: p.methodId, requestedBy: 'tester', invoices: [1, 2, 3].map((n) => invoice(`${word}-${String(n)}`, `AC${String(n)}`, '5.00')) });
      await engine.bills.sent(p.providerId, [`${word}-1`, `${word}-2`], { id: null, status: 'succeeded', failureReason: null });
      const first = await engine.bills.list(companyId, { q: word, limit: 2 });
      expect(first.rows).toHaveLength(2);
      expect(first.nextBefore).not.toBeNull();
      const rest = await engine.bills.list(companyId, { q: word, limit: 2, before: first.nextBefore ?? undefined });
      expect(rest.rows).toHaveLength(1);
      expect((await engine.bills.list(companyId, { q: word, status: 'sent' })).rows).toHaveLength(2);
      expect((await engine.bills.list(companyId, { q: '%' })).rows.every((r) => r.reference.includes('%'))).toBe(true);
      expect((await engine.bills.counts(companyId)).sent).toBeGreaterThanOrEqual(2);
      expect(await engine.bills.list(randomUUID(), { q: word })).toMatchObject({ rows: [] });
    });
  });

  describe('the records cannot be rewritten', () => {
    const dbError = async (q: PromiseLike<unknown>) => {
      try {
        await q;
        return 'OK';
      } catch (e) {
        return ((e as { cause?: Error }).cause ?? (e as Error)).message;
      }
    };
    it('events, operations and transactions are kept, and a counted payment cannot be counted again', async () => {
      const p = await provider();
      const a = await startPayment(p);
      await callback(a.attempt, stkBody(a.attempt));
      const [ev] = await events(a.attempt.id);
      expect(await dbError(db.update(schema.providerEvents).set({ rawText: 'edited' }).where(eq(schema.providerEvents.id, ev.id)))).toMatch(/cannot be edited/);
      expect(await dbError(db.delete(schema.providerEvents).where(eq(schema.providerEvents.id, ev.id)))).toMatch(/kept/);
      stkQuery(0);
      await engine.verification.verifyAttempt(a.attempt.id);
      const tx = (await db.select().from(schema.providerTransactions).where(eq(schema.providerTransactions.consumedId, a.attempt.id)))[0];
      expect(await dbError(db.update(schema.providerTransactions).set({ consumedId: 'someone-else' }).where(eq(schema.providerTransactions.id, tx.id)))).toMatch(/counted/);
      expect(await dbError(db.update(schema.providerTransactions).set({ amount: '1' }).where(eq(schema.providerTransactions.id, tx.id)))).toMatch(/keeps its reference/);
      expect(await engine.txs.consume(tx.id, 'x', 'y')).toBe(false);
      const op = (await engine.ops.bySubject('payment_attempt', a.attempt.id, 'stk_push'))[0];
      expect(await dbError(db.delete(schema.providerOperations).where(eq(schema.providerOperations.id, op.id)))).toMatch(/kept/);
      const fin2 = await engine.ops.create({ companyId, providerId: p.providerId, operation: 'qr_generate', idempotencyKey: `done:${run}:${++seq}`, status: 'queued' });
      await engine.ops.update(fin2.op.id, { status: 'succeeded' });
      expect(await dbError(db.update(schema.providerOperations).set({ status: 'queued' }).where(eq(schema.providerOperations.id, fin2.op.id)))).toMatch(/finished/);
    });
  });
});

