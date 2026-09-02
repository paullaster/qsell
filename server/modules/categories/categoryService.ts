import { db } from '../../db/postgresStore.js';
import { Category } from '../../../src/types/index.js';

export class CategoryService {
  public static getAllCategories(): Category[] {
    return db.getAllCategories();
  }

  public static getCategoryById(id: string): Category | undefined {
    return db.getCategoryById(id);
  }

  public static createCategory(data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>): Category {
    return db.createCategory(data);
  }

  public static updateCategory(id: string, updates: Partial<Category>): Category {
    return db.updateCategory(id, updates);
  }

  public static deleteCategory(id: string): boolean {
    return db.deleteCategory(id);
  }
}
