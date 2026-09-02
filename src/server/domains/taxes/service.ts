import { db } from '@/server/db/store';
import type { TaxCategory } from '@/types/index';

export class TaxDomainService {
  static getAll(): TaxCategory[] {
    return db.getAllTaxCategories();
  }

  static getById(id: string): TaxCategory | undefined {
    return db.getTaxCategoryById(id);
  }

  static create(
    data: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
  ): TaxCategory {
    return db.createTaxCategory(data);
  }

  static update(id: string, updates: Partial<TaxCategory>): TaxCategory {
    return db.updateTaxCategory(id, updates);
  }

  static remove(id: string): boolean {
    return db.deleteTaxCategory(id);
  }

  static setDefault(id: string): TaxCategory {
    return db.setDefaultTaxCategory(id);
  }
}
