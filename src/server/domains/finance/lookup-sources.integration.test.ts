import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Sources from '@/server/domains/lookups/sources';
import type * as Request from '@/server/domains/lookups/request';

/**
 * The lists behind the receipt and refund screens' pickers, against a real database: what each
 * offers, what it hides (inactive customers, closed banks, other companies), and the facts it
 * attaches to an option.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('finance lookup sources (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let sources: typeof Sources;
  let request: typeof Request;
  let companyId: string;
  let otherCompanyId: string;
  const tag = randomUUID().slice(0, 8);

  const search = async (key: string, over: { query?: string; filters?: Record<string, string> } = {}) => {
    const parsed = request.parseLookupRequest({ source: key, query: over.query, filters: over.filters });
    if (!parsed.ok) throw new Error(parsed.error);
    const source = sources.getLookupSource(key);
    if (source === undefined) throw new Error(`no source ${key}`);
    const { query, limit, after, filters } = parsed.value;
    return await source.search({ companyId, query, limit, after, filters });
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    sources = await import('@/server/domains/lookups/sources');
    request = await import('@/server/domains/lookups/request');
    companyId = (await mod.getContainer().companySettings.ensureSeeded()).id;
    otherCompanyId = (
      await db
        .insert(schema.companySettings)
        .values({ legalName: `Other ${tag}`, tradingName: `Other ${tag}`, email: `o-${tag}@example.test`, phone: '0', streetAddress: '1', city: 'N', countyOrState: 'N', postalCode: '0', kraPin: `P${tag}` })
        .returning()
    )[0].id;

    const customer = (company: string, n: string, over: Record<string, unknown> = {}) =>
      db.insert(schema.customers).values({ companyId: company, number: `${tag}-${n}`, name: `${tag} Cust ${n}`, accountType: 'cash', phone: `0700${n}`, ...over });
    await customer(companyId, '1', { accountType: 'credit', balance: '250.00' });
    await customer(companyId, '2', { isActive: false });
    await customer(otherCompanyId, '3');

    const bank = (code: string, over: Record<string, unknown> = {}) =>
      db.insert(schema.bankAccounts).values({ companyId, code: `${tag}${code}`, name: `${tag} Bank ${code}`, kind: 'bank', currency: 'KES', createdBy: 'test', ...over }).returning();
    const bankOpen = (await bank('A'))[0].id;
    const bankClosed = (await bank('B', { blocked: true }))[0].id;
    const bankUsd = (await bank('U', { currency: 'USD' }))[0].id;
    const gl = (
      await db.insert(schema.glAccounts).values({ companyId, no: `${tag}1`, name: `${tag} GL`, type: 'posting', category: 'assets', normalBalance: 'debit' }).returning()
    )[0].id;
    const provider = (
      await db.insert(schema.paymentProviderConfigs).values({ companyId, providerCode: 'mpesa_daraja', displayName: `P ${tag}`, apiBaseUrl: 'https://x.example.test' }).returning()
    )[0].id;
    const method = (code: string, bankId: string, over: Record<string, unknown> = {}) =>
      db.insert(schema.paymentMethods).values({ companyId, code: `${tag}${code}`, name: `${tag} ${code}`, kind: 'mobile_money', balancingBankAccountId: bankId, providerId: provider, glAccountId: gl, createdBy: 'test', ...over });
    await method('RC', bankOpen, { usableFor: ['customer_receipt'], requiresReference: true, limits: { min: '10' } });
    await method('RF', bankOpen, { usableFor: ['customer_receipt', 'customer_refund'], refundDestination: 'manual' });
    await method('RA', bankOpen, { usableFor: ['customer_refund'], refundDestination: 'automatic' });
    await method('CL', bankClosed, { usableFor: ['customer_receipt', 'customer_refund'], refundDestination: 'manual' });
    await method('UD', bankUsd, { usableFor: ['customer_receipt', 'customer_refund'], refundDestination: 'manual' });
    await method('CQ', bankOpen, { kind: 'cheque', usableFor: ['customer_refund'], refundDestination: 'manual' });
    await db.insert(schema.reasonCodes).values([
      { companyId, code: `${tag}R1`, description: `${tag} Wrong item`, requiresComment: true },
      { companyId, code: `${tag}R2`, description: `${tag} Retired`, isActive: false },
    ]);
  });

  it('offers active customers of this company with their standing', async () => {
    const found = await search('receipt-customers', { query: tag });
    expect(found.options.map((o) => o.label)).toEqual([`${tag} Cust 1`]);
    expect(found.options[0]).toMatchObject({ badge: 'Credit', meta: { accountType: 'credit', balance: '250.00', phone: '07001' } });
    expect((await search('refund-customers', { query: `${tag}-1` })).options).toHaveLength(1);
    expect((await search('receipt-customers', { query: '0700' + '1' })).options.map((o) => o.label)).toContain(`${tag} Cust 1`);
  });

  it('offers only methods usable for receipts, on open banks, with the facts the form needs', async () => {
    const labels = (await search('receipt-methods', { query: tag })).options.map((o) => o.label);
    expect(labels).toEqual([`${tag} RC`, `${tag} RF`, `${tag} UD`]);
    const rc = (await search('receipt-methods', { query: `${tag} RC` })).options[0];
    expect(rc.meta).toMatchObject({ currency: 'KES', requiresReference: '1', requiresEvidence: '', min: '10', max: '' });
    expect((await search('receipt-methods', { query: `${tag} UD` })).options[0]?.meta?.currency).toBe('USD');
  });

  it('offers only hand-paid refund methods on open banks', async () => {
    const labels = (await search('refund-methods', { query: tag })).options.map((o) => o.label);
    expect(labels).toEqual([`${tag} CQ`, `${tag} RF`, `${tag} UD`]);
  });

  it('offers payout methods in the refund’s currency, never cheques, and refuses other filters', async () => {
    const kes = (await search('refund-payout-methods', { query: tag, filters: { currency: 'KES' } })).options.map((o) => o.label.split(' — ')[0]);
    expect(kes).toEqual([`${tag} RA`, `${tag} RC`, `${tag} RF`]);
    const usd = (await search('refund-payout-methods', { query: tag, filters: { currency: 'USD' } })).options.map((o) => o.label.split(' — ')[0]);
    expect(usd).toEqual([`${tag} UD`]);
    await expect(search('refund-payout-methods', { filters: { currency: 'kes' } })).rejects.toThrow();
    await expect(search('refund-payout-methods')).rejects.toThrow();
  });

  it('offers cheque deposit banks (bank accounts only, open)', async () => {
    const labels = (await search('cheque-deposit-methods', { query: tag })).options.map((o) => o.label);
    expect(labels.every((l) => l.includes(`${tag}A`) || l.includes(`${tag}U`))).toBe(true);
    expect(labels.some((l) => l.includes(`${tag}B`))).toBe(false);
  });

  it('offers active reasons and says which need a comment', async () => {
    const reasons = (await search('refund-reasons', { query: tag })).options;
    expect(reasons.map((o) => o.label)).toEqual([`${tag} Wrong item`]);
    expect(reasons[0]?.meta?.requiresComment).toBe('1');
    expect((await search('receipt-reasons', { query: tag })).options).toHaveLength(1);
  });

  it('offers the wallet, return and credit note lists', async () => {
    expect((await search('wallet-overpayment-modes')).options.map((o) => o.id).sort()).toEqual(['ask', 'hold', 'wallet']);
    expect((await search('wallet-auto-apply-modes')).options.map((o) => o.id).sort()).toEqual(['never', 'oldest_first']);
    expect((await search('wallet-credit-note-modes')).options.map((o) => o.id).sort()).toEqual(['ask', 'wallet']);
    expect((await search('return-conditions', { query: 'damag' })).options.map((o) => o.id)).toEqual(['damaged']);
    expect((await search('return-dispositions')).options).toHaveLength(4);
    expect((await search('credit-note-reasons', { query: 'good' })).options.map((o) => o.id).sort()).toEqual(['damaged_goods', 'goodwill', 'returned_goods']);
    expect((await search('wallet-reasons', { query: tag })).options.map((o) => o.label)).toEqual([`${tag} Wrong item`]);
    expect((await search('return-close-reasons', { query: tag })).options).toHaveLength(1);
    await expect(search('wallet-overpayment-modes', { filters: { x: 'y' } })).rejects.toThrow();
  });

  it('offers the fixed lists and asks for the customer before listing what is owed', async () => {
    expect((await search('receipt-statuses')).options.map((o) => o.id).sort()).toEqual(['cancelled', 'draft', 'posted', 'reversed']);
    expect((await search('refund-statuses', { query: 'paid' })).options.map((o) => o.id)).toContain('paid');
    expect((await search('allocation-modes')).options.map((o) => o.id).sort()).toEqual(['none', 'oldest_first']);
    await expect(search('refund-sources')).rejects.toThrow();
    await expect(search('refund-sources', { filters: { customer: 'nope' } })).rejects.toThrow();
    expect((await search('refund-sources', { filters: { customer: randomUUID() } })).options).toEqual([]);
  });
});
