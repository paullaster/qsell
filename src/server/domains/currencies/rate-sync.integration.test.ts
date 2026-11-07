import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Container from '@/server/di/container';
import type * as Service from './service';
import type { FinanceContext } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';

/**
 * The shop's display rate follows the books' exchange rate, against a real database:
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('the shop rate follows the books rate (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let companyId: string;
  let ctx: FinanceContext;
  let fx: ReturnType<typeof Container.getContainer>['finance']['fx'];
  let service: typeof Service.CurrencyDomainService;
  let base = '';
  let previousFinanceBase: string | null = null;
  const USD = 'ZZA';
  const EUR = 'ZZB';
  const today = businessDate();
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  const row = async (code: string) => (await db.select().from(schema.currencies).where(eq(schema.currencies.code, code)))[0];
  const clearRates = async () => await db.delete(schema.exchangeRates).where(and(eq(schema.exchangeRates.companyId, companyId), inArray(schema.exchangeRates.currency, [USD, EUR])));
  const setFinanceBase = async (code: string) =>
    await db.insert(schema.financeSettings).values({ companyId, baseCurrency: code }).onConflictDoUpdate({ target: schema.financeSettings.companyId, set: { baseCurrency: code } });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    service = (await import('./service')).CurrencyDomainService;
    const container = mod.getContainer();
    fx = container.finance.fx;
    companyId = (await container.companySettings.ensureSeeded()).id;
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin: { surface: 'test', action: 'rate-sync' } };
    // The shop needs a base currency, and the books must use the same one for the two to agree.
    const existingBase = (await db.select().from(schema.currencies).where(eq(schema.currencies.isBaseCurrency, true)))[0];
    base = existingBase?.code ?? 'ZZK';
    if (existingBase === undefined) await db.insert(schema.currencies).values({ code: base, name: 'Test base', symbol: 'B', exchangeRate: '1', isBaseCurrency: true });
    previousFinanceBase = (await db.select().from(schema.financeSettings).where(eq(schema.financeSettings.companyId, companyId)))[0]?.baseCurrency ?? null;
    await setFinanceBase(base);
    await db.insert(schema.currencies).values([
      { code: USD, name: 'Test dollar', symbol: '$', exchangeRate: '0.01000000', isBaseCurrency: false, isEnabled: true },
      { code: EUR, name: 'Test euro', symbol: 'E', exchangeRate: '0.02000000', isBaseCurrency: false, isEnabled: true },
    ]).onConflictDoUpdate({ target: schema.currencies.code, set: { exchangeRate: '0.01000000' } });
    await db.update(schema.currencies).set({ exchangeRate: '0.02000000' }).where(eq(schema.currencies.code, EUR));
    await clearRates();
  });

  afterAll(async () => {
    await clearRates();
    await db.delete(schema.currencies).where(inArray(schema.currencies.code, [USD, EUR, 'ZZK']));
    if (previousFinanceBase !== null) await setFinanceBase(previousFinanceBase);
  });

  it('keeps the typed rate while the books have none for the currency', async () => {
    expect(await fx.syncDisplayRates(db, companyId)).toEqual([]);
    expect((await row(USD))?.exchangeRate).toBe('0.01000000');
  });

  it('follows a books rate set for today, in the same step, and leaves other currencies alone', async () => {
    await fx.setRate(ctx, { currency: USD, effectiveOn: today, rate: '129.5' });
    expect((await row(USD))?.exchangeRate).toBe('0.00772201');
    expect((await row(EUR))?.exchangeRate).toBe('0.02000000');
  });

  it('does nothing when it runs again, and writes only what differs', async () => {
    const before = (await row(USD))?.updatedAt.getTime();
    expect(await fx.syncDisplayRates(db, companyId)).toEqual([]);
    expect((await row(USD))?.updatedAt.getTime()).toBe(before);
  });

  it('does not follow a rate that starts tomorrow until tomorrow', async () => {
    await fx.setRate(ctx, { currency: EUR, effectiveOn: tomorrow, rate: '140' });
    expect((await row(EUR))?.exchangeRate).toBe('0.02000000');
    const governing = await fx.governing(db, companyId);
    expect(governing.rates.has(EUR)).toBe(false);
    expect(governing.rates.get(USD)).toMatchObject({ rate: '129.50000000', since: today });
  });

  it('refuses to type a rate for a currency the books decide, and says where to change it', async () => {
    await expect(service.update(USD, { exchangeRate: 0.0123 })).rejects.toThrow(/Finance → Exchange rates/);
    expect((await row(USD))?.exchangeRate).toBe('0.00772201');
    // The same screen sending the rate back unchanged, with another field edited, is fine.
    const saved = await service.update(USD, { exchangeRate: 0.00772201, name: 'Test dollar (renamed)' });
    expect(saved.name).toBe('Test dollar (renamed)');
    expect(saved.exchangeRate).toBeCloseTo(0.00772201, 8);
  });

  it('lets a rate be typed for a currency the books have no rate for yet', async () => {
    const saved = await service.update(EUR, { exchangeRate: 0.025 });
    expect(saved.exchangeRate).toBeCloseTo(0.025, 8);
  });

  it('marks each currency with the rate that decides it, for the admin screen', async () => {
    const { currencies, link } = await service.getAllForAdmin();
    expect(link).toEqual({ financeBase: base, displayBase: base, basesDiffer: false });
    expect(currencies.find((c) => c.code === USD)?.financeRate).toMatchObject({ since: today });
    expect(currencies.find((c) => c.code === EUR)?.financeRate).toBeNull();
    expect(currencies.find((c) => c.code === base)?.financeRate).toBeNull();
  });

  it('when the books rate is removed, the shop keeps the last rate it had and the rate can be typed again', async () => {
    const [rate] = await db.select().from(schema.exchangeRates).where(and(eq(schema.exchangeRates.companyId, companyId), eq(schema.exchangeRates.currency, USD)));
    if (rate === undefined) throw new Error('the test rate is missing');
    await fx.removeRate(ctx, rate.id);
    // Nothing decides it any more, so it may be typed again; what the shop shows meanwhile is the last books rate, not a jump.
    expect((await row(USD))?.exchangeRate).toBe('0.00772201');
    expect((await service.getAllForAdmin()).currencies.find((c) => c.code === USD)?.financeRate).toBeNull();
    const saved = await service.update(USD, { exchangeRate: 0.0079 });
    expect(saved.exchangeRate).toBeCloseTo(0.0079, 8);
  });

  it('does not follow the books when the two bases are different currencies', async () => {
    await fx.setRate(ctx, { currency: USD, effectiveOn: today, rate: '130' });
    expect((await row(USD))?.exchangeRate).toBe('0.00769231');
    await setFinanceBase('ZZY');
    const governing = await fx.governing(db, companyId);
    expect(governing.basesDiffer).toBe(true);
    expect(governing.rates.size).toBe(0);
    expect(await fx.syncDisplayRates(db, companyId)).toEqual([]);
    // With nothing deciding the rate, it can be typed.
    const saved = await service.update(USD, { exchangeRate: 0.0075 });
    expect(saved.exchangeRate).toBeCloseTo(0.0075, 8);
    await setFinanceBase(base);
  });
});
