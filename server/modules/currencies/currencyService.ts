import { db } from '../../db/postgresStore.js';
import { CurrencyConfig } from '../../../src/types/index.js';

export class CurrencyService {
  public static getAllCurrencies(): CurrencyConfig[] {
    return db.getAllCurrencies();
  }

  public static getCurrencyByCode(code: string): CurrencyConfig | undefined {
    return db.getCurrencyByCode(code);
  }

  public static createCurrency(data: CurrencyConfig): CurrencyConfig {
    return db.createCurrency(data);
  }

  public static updateCurrency(code: string, updates: Partial<CurrencyConfig>): CurrencyConfig {
    return db.updateCurrency(code, updates);
  }

  public static deleteCurrency(code: string): boolean {
    return db.deleteCurrency(code);
  }

  public static setBaseCurrency(code: string): CurrencyConfig {
    return db.setBaseCurrency(code);
  }
}
