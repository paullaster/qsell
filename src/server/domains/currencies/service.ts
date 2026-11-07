import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import type { CurrencyConfig } from '@/types/index';
import { toCurrency } from '@/server/domains/catalog/mappers';

/** How the shop's base currency and the books' compare: the shop follows the books' rates only when they are the same currency. */
export interface FinanceLink {
  financeBase: string | null;
  displayBase: string | null;
  basesDiffer: boolean;
}

function repo() {
  return getContainer().catalog;
}

/** Enabled display currencies, backed by the `currencies` table. */
export class CurrencyDomainService {
  static async getAll(): Promise<CurrencyConfig[]> {
    const rows = await repo().listCurrencies();
    return rows.map(toCurrency);
  }

  /**
   * The currencies for the admin screen, each marked with the books' rate that decides its rate, when there is one.
   * The books' rate wins: it is dated and audited, and the shop follows it (see FxService.syncDisplayRates).
   */
  static async getAllForAdmin(): Promise<{ currencies: CurrencyConfig[]; link: FinanceLink }> {
    const container = getContainer();
    const company = await container.companySettings.ensureSeeded();
    const [rows, governing] = await Promise.all([repo().listCurrencies(), container.finance.fx.governing(container.db, company.id)]);
    return {
      currencies: rows.map((row) => ({ ...toCurrency(row), financeRate: row.isBaseCurrency ? null : (governing.rates.get(row.code) ?? null) })),
      link: { financeBase: governing.financeBase, displayBase: governing.displayBase, basesDiffer: governing.basesDiffer },
    };
  }

  /** Brings the shop's rates in line with the books' (after a currency was added, enabled or made the base, or when a day starts). */
  static async syncWithBooks(): Promise<string[]> {
    const container = getContainer();
    const company = await container.companySettings.ensureSeeded();
    const changed = await container.finance.fx.syncDisplayRates(container.db, company.id);
    if (changed.length > 0) void broadcastRealtime('currency_update', { type: 'rates_synced', codes: changed });
    return changed;
  }

  static async getByCode(code: string): Promise<CurrencyConfig | undefined> {
    const row = await repo().getCurrencyByCode(code);
    return row ? toCurrency(row) : undefined;
  }

  static async create(data: CurrencyConfig): Promise<CurrencyConfig> {
    const row = await repo().upsertCurrency({
      code: data.code.toUpperCase().trim(),
      name: data.name,
      symbol: data.symbol,
      exchangeRate: String(data.exchangeRate),
      isBaseCurrency: data.isBaseCurrency ?? false,
      decimalDigits: data.decimalDigits ?? 2,
      symbolPosition: data.symbolPosition ?? 'prefix',
      isEnabled: data.isEnabled ?? true,
      flagEmoji: data.flagEmoji ?? null,
    });
    await CurrencyDomainService.syncWithBooks();
    const created = toCurrency((await repo().getCurrencyByCode(row.code)) ?? row);
    void broadcastRealtime('currency_update', { type: 'created', currency: created });
    return created;
  }

  static async update(code: string, updates: Partial<CurrencyConfig>): Promise<CurrencyConfig> {
    const upper = code.toUpperCase().trim();
    const existing = await repo().getCurrencyByCode(upper);
    if (!existing) throw new Error(`Currency ${upper} not found`);

    // A screen that sends the whole form back unchanged must not trip this: compare at the precision the rate is stored at.
    if (updates.exchangeRate !== undefined && Number(updates.exchangeRate.toFixed(8)) !== Number(existing.exchangeRate)) {
      const { currencies: all } = await CurrencyDomainService.getAllForAdmin();
      const books = all.find((c) => c.code === upper)?.financeRate ?? null;
      if (books !== null) {
        throw new Error(`The rate of ${upper} comes from Finance → Exchange rates (1 ${upper} = ${Number(books.rate)} since ${books.since}). Change it there: the shop follows it.`);
      }
    }

    const row = await repo().updateCurrency(upper, {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.symbol !== undefined ? { symbol: updates.symbol } : {}),
      ...(updates.exchangeRate !== undefined
        ? { exchangeRate: String(updates.exchangeRate) }
        : {}),
      ...(updates.decimalDigits !== undefined ? { decimalDigits: updates.decimalDigits } : {}),
      ...(updates.symbolPosition !== undefined
        ? { symbolPosition: updates.symbolPosition }
        : {}),
      ...(updates.isEnabled !== undefined ? { isEnabled: updates.isEnabled } : {}),
      ...(updates.flagEmoji !== undefined ? { flagEmoji: updates.flagEmoji ?? null } : {}),
    });
    if (!row) throw new Error(`Currency ${upper} not found`);

    await CurrencyDomainService.syncWithBooks();
    const updated = toCurrency((await repo().getCurrencyByCode(upper)) ?? row);
    void broadcastRealtime('currency_update', { type: 'updated', currency: updated });
    return updated;
  }

  static async remove(code: string): Promise<boolean> {
    const upper = code.toUpperCase().trim();
    const existing = await repo().getCurrencyByCode(upper);
    if (!existing) return false;

    if (existing.isBaseCurrency) {
      throw new Error(
        'Cannot delete the primary base currency. Designate another base currency first.',
      );
    }

    const deleted = await repo().deleteCurrency(upper);
    if (deleted) {
      void broadcastRealtime('currency_update', { type: 'deleted', currencyCode: upper });
    }
    return deleted;
  }

  static async setBase(code: string): Promise<CurrencyConfig> {
    const upper = code.toUpperCase().trim();
    const target = await repo().getCurrencyByCode(upper);
    if (!target) throw new Error(`Currency ${upper} not found`);

    await repo().setBaseCurrency(upper);
    await CurrencyDomainService.syncWithBooks();
    void broadcastRealtime('currency_update', { type: 'base_changed', baseCurrency: upper });
    return toCurrency(target);
  }
}
