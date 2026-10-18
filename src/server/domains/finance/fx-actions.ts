'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from './action-runner';
import { formatAmount } from './domain/amount';
import { FinanceError } from './errors';

const fin = () => getContainer().finance;
const PATH = '/admin/finance/exchange-rates';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function exchangeRatesOverviewAction() {
  return await run('exchange_rates:read', { surface: 'finance/exchange-rates', action: 'view' }, async (ctx) => {
    const [settings, latest, revaluations] = await Promise.all([fin().setup.getSettings(ctx.companyId), fin().fx.latest(ctx.companyId), fin().fx.revaluations(ctx.companyId, 10)]);
    return {
      baseCurrency: settings?.baseCurrency ?? '',
      live: settings?.salesGlGoLive != null,
      latest: latest.map((r) => ({ currency: r.currency, rate: r.rate, effectiveOn: r.effectiveOn })),
      revaluations: revaluations.map((r) => ({ id: r.id, asOf: r.asOf, net: r.net, rates: r.rates, undone: r.reversedAt !== null })),
      can: { manage: await canPermission('exchange_rates:manage'), revalue: await canPermission('exchange_rates:revalue') },
    };
  });
}

export async function listExchangeRatesAction(input: { currency?: string; before?: string }) {
  return await run('exchange_rates:read', { surface: 'finance/exchange-rates', action: 'list' }, async (ctx) => {
    const page = await fin().fx.rates(ctx.companyId, { currency: input.currency, before: input.before, limit: 25 });
    return { rows: page.rows.map((r) => ({ id: r.id, currency: r.currency, effectiveOn: r.effectiveOn, rate: r.rate, note: r.note, createdBy: r.createdBy })), nextBefore: page.nextBefore };
  });
}

export async function setExchangeRateAction(input: { currency: string; effectiveOn: string; rate: string; note?: string }) {
  return await run('exchange_rates:manage', { surface: 'finance/exchange-rates', action: 'set' }, async (ctx) => {
    const note = input.note?.trim().slice(0, 200);
    const row = await fin().fx.setRate(ctx, { currency: input.currency, effectiveOn: input.effectiveOn, rate: input.rate, note: note === '' ? null : note });
    return { id: row.id };
  }, [PATH]);
}

export async function removeExchangeRateAction(id: string) {
  return await run('exchange_rates:manage', { surface: 'finance/exchange-rates', action: 'remove' }, async (ctx) => {
    if (!UUID.test(id)) throw new FinanceError('NOT_FOUND', 'That rate does not exist.');
    await fin().fx.removeRate(ctx, id);
    return {};
  }, [PATH]);
}

export async function revalueForeignBalancesAction() {
  return await run('exchange_rates:revalue', { surface: 'finance/exchange-rates', action: 'revalue' }, async (ctx) => {
    const r = await fin().fx.revalue(ctx);
    return { net: formatAmount(BigInt(r.netCents) * 100n), groups: r.groups };
  }, [PATH]);
}
