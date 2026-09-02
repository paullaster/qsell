import { db } from '../../db/postgresStore.js';
import { TaxCategory } from '../../../src/types/index.js';

export class TaxService {
  public static getAllTaxCategories(): TaxCategory[] {
    return db.getAllTaxCategories();
  }

  public static getTaxCategoryById(id: string): TaxCategory | undefined {
    return db.getTaxCategoryById(id);
  }

  public static createTaxCategory(data: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>): TaxCategory {
    return db.createTaxCategory(data);
  }

  public static updateTaxCategory(id: string, updates: Partial<TaxCategory>): TaxCategory {
    return db.updateTaxCategory(id, updates);
  }

  public static deleteTaxCategory(id: string): boolean {
    return db.deleteTaxCategory(id);
  }

  public static setDefaultTaxCategory(id: string): TaxCategory {
    return db.setDefaultTaxCategory(id);
  }
}
