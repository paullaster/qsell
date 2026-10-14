import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Sources from '@/server/domains/lookups/sources';
import type * as Request from '@/server/domains/lookups/request';

/**
 * The lists behind the payment screens' pickers, against a real database: company scoping, the
 * filters they accept and refuse, and which rows each one offers.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('payment lookup sources (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let sources: typeof Sources;
  let request: typeof Request;
  let companyId: string;
  let otherCompanyId: string;
  let providerId: string;
  let otherProviderId: string;
  const tag = randomUUID().slice(0, 8);

  const search = async (key: string, over: { query?: string; filters?: Record<string, string> } = {}, company = () => companyId) => {
    const parsed = request.parseLookupRequest({ source: key, query: over.query, filters: over.filters });
    if (!parsed.ok) throw new Error(parsed.error);
    const source = sources.getLookupSource(key);
    if (source === undefined) throw new Error(`no source ${key}`);
    const { query, limit, after, filters } = parsed.value;
    return await source.search({ companyId: company(), query, limit, after, filters });
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
    const provider = (company: string, name: string) =>
      db.insert(schema.paymentProviderConfigs).values({ companyId: company, providerCode: 'mpesa_daraja', displayName: name, apiBaseUrl: 'https://sandbox.example.test' }).returning();
    providerId = (await provider(companyId, `P ${tag}`))[0].id;
    otherProviderId = (await provider(otherCompanyId, `Q ${tag}`))[0].id;

    const bank = (company: string, code: string, over: Record<string, unknown> = {}) =>
      db.insert(schema.bankAccounts).values({ companyId: company, code: `${tag}${code}`, name: `${tag} Bank ${code}`, kind: 'bank', currency: 'KES', createdBy: 'test', ...over }).returning();
    const bankA = (await bank(companyId, 'A'))[0].id;
    await bank(companyId, 'B', { blocked: true });
    await bank(otherCompanyId, 'C');

    const gl = (company: string, no: string, over: Record<string, unknown> = {}) =>
      db.insert(schema.glAccounts).values({ companyId: company, no: `${tag}${no}`, name: `${tag} GL ${no}`, type: 'posting', category: 'assets', normalBalance: 'debit', ...over }).returning();
    const glA = (await gl(companyId, '1'))[0].id;
    await gl(companyId, '2', { category: 'income' });
    await gl(companyId, '3', { blocked: true });
    await gl(otherCompanyId, '4');

    const method = (code: string, provider: string, channelKind: string | null, channelNumber: string | null, company = companyId) =>
      db.insert(schema.paymentMethods).values({ companyId: company, code: `${tag}${code}`, name: `${tag} ${code}`, kind: 'mobile_money', balancingBankAccountId: bankA, providerId: provider, glAccountId: glA, channelKind, channelNumber, createdBy: 'test' });
    await method('PB', providerId, 'paybill', '600100');
    await method('TL', providerId, 'till', '300200');
    await method('NO', providerId, null, null);
    await method('EL', otherProviderId, 'paybill', '999999', otherCompanyId);
  });

  it('offers branches, open bank accounts and open asset posting accounts of this company only', async () => {
    expect((await search('bank-accounts', { query: tag })).options.map((o) => o.label)).toEqual([`${tag}A — ${tag} Bank A (KES)`]);
    expect((await search('asset-gl-accounts', { query: tag })).options.map((o) => o.label)).toEqual([`${tag}1 ${tag} GL 1`]);
    expect((await search('branches', { query: `no-such-${tag}` })).options).toEqual([]);
  });

  it('offers the numbers under one provider, and none from another company', async () => {
    const mine = await search('provider-numbers', { filters: { provider: providerId } });
    expect(mine.options.map((o) => o.label).sort()).toEqual([`${tag} PB (paybill 600100)`, `${tag} TL (till 300200)`]);
    expect((await search('provider-numbers', { filters: { provider: otherProviderId } })).options).toEqual([]);
    await expect(search('provider-numbers', { filters: { provider: 'not-a-uuid' } })).rejects.toThrow();
    await expect(search('provider-numbers', { filters: { other: 'x' } })).rejects.toThrow();
  });

  it('offers only paybills of M-Pesa providers for Bill Manager', async () => {
    const labels = (await search('bill-paybills', { query: tag })).options.map((o) => o.label);
    expect(labels).toEqual([`${tag} PB · paybill 600100`]);
  });

  it('offers the fixed lists and refuses filters they do not have', async () => {
    expect((await search('provider-environments')).options.map((o) => o.id)).toEqual(['production', 'staging']);
    expect((await search('payment-method-kinds', { query: 'cheq' })).options.map((o) => o.id)).toEqual(['cheque']);
    await expect(search('provider-environments', { filters: { x: 'y' } })).rejects.toThrow();
  });

  it('offers the choices of one select field of one operation, and nothing else', async () => {
    const trx = await search('daraja-field-options', { filters: { operation: 'qr_generate', field: 'trxCode' } });
    expect(trx.options.map((o) => o.id)).toEqual(['PB', 'SM', 'BG', 'WA']);
    await expect(search('daraja-field-options', { filters: { operation: 'qr_generate', field: 'amount' } })).rejects.toThrow();
    await expect(search('daraja-field-options', { filters: { operation: 'nope', field: 'x' } })).rejects.toThrow();
    await expect(search('daraja-operations')).rejects.toThrow();
  });
});
