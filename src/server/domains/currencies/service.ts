import { db } from '@/server/db/store';
import type { CurrencyConfig } from '@/types/index';

export class CurrencyDomainService {
  static getAll(): CurrencyConfig[] {
    return db.getAllCurrencies();
  }

  static getByCode(code: string): CurrencyConfig | undefined {
    return db.getCurrencyByCode(code);
  }

  static create(data: CurrencyConfig): CurrencyConfig {
    return db.createCurrency(data);
  }

  static update(code: string, updates: Partial<CurrencyConfig>): CurrencyConfig {
    return db.updateCurrency(code, updates);
  }

  static remove(code: string): boolean {
    return db.deleteCurrency(code);
  }

  static setBase(code: string): CurrencyConfig {
    return db.setBaseCurrency(code);
  }
}
