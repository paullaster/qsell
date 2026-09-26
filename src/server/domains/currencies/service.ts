import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import type { CurrencyConfig } from '@/types/index';
import { toCurrency } from '@/server/domains/catalog/mappers';

function repo() {
  return getContainer().catalog;
}

/** Enabled display currencies, backed by the `currencies` table. */
export class CurrencyDomainService {
  static async getAll(): Promise<CurrencyConfig[]> {
    const rows = await repo().listCurrencies();
    return rows.map(toCurrency);
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
    const created = toCurrency(row);
    void broadcastRealtime('currency_update', { type: 'created', currency: created });
    return created;
  }

  static async update(code: string, updates: Partial<CurrencyConfig>): Promise<CurrencyConfig> {
    const upper = code.toUpperCase().trim();
    const existing = await repo().getCurrencyByCode(upper);
    if (!existing) throw new Error(`Currency ${upper} not found`);

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

    const updated = toCurrency(row);
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
    void broadcastRealtime('currency_update', { type: 'base_changed', baseCurrency: upper });
    return toCurrency(target);
  }
}
