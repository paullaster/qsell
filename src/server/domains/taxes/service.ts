import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import type { TaxCategory } from '@/types/index';
import { toTaxCategory } from '@/server/domains/catalog/mappers';

function repo() {
  return getContainer().catalog;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** VAT/GST/excise rate definitions, backed by the `tax_categories` table. */
export class TaxDomainService {
  static async getAll(): Promise<TaxCategory[]> {
    const rows = await repo().listTaxCategories();
    return rows.map((row) => toTaxCategory(row, row.productCount));
  }

  static async getById(id: string): Promise<TaxCategory | undefined> {
    const row = await repo().getTaxCategoryById(id);
    return row ? toTaxCategory(row) : undefined;
  }

  static async create(
    data: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
  ): Promise<TaxCategory> {
    const catalog = repo();
    if (data.isDefault) await catalog.clearDefaultTaxCategory('__none__');

    const row = await catalog.insertTaxCategory({
      id: newId('tax'),
      name: data.name,
      code: data.code,
      rate: String(data.rate),
      type: data.type,
      countryCode: data.countryCode ?? '',
      countryName: data.countryName ?? '',
      description: data.description ?? '',
      isInclusive: data.isInclusive ?? false,
      isDefault: data.isDefault ?? false,
      isActive: data.isActive ?? true,
    });

    const created = toTaxCategory(row);
    void broadcastRealtime('tax_category_update', { type: 'created', taxCategory: created });
    return created;
  }

  static async update(id: string, updates: Partial<TaxCategory>): Promise<TaxCategory> {
    const catalog = repo();
    const existing = await catalog.getTaxCategoryById(id);
    if (!existing) throw new Error(`Tax category ${id} not found`);

    if (updates.isDefault) await catalog.clearDefaultTaxCategory(id);

    const row = await catalog.updateTaxCategory(id, {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.code !== undefined ? { code: updates.code } : {}),
      ...(updates.rate !== undefined ? { rate: String(updates.rate) } : {}),
      ...(updates.type !== undefined ? { type: updates.type } : {}),
      ...(updates.countryCode !== undefined ? { countryCode: updates.countryCode } : {}),
      ...(updates.countryName !== undefined ? { countryName: updates.countryName } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.isInclusive !== undefined ? { isInclusive: updates.isInclusive } : {}),
      ...(updates.isDefault !== undefined ? { isDefault: updates.isDefault } : {}),
      ...(updates.isActive !== undefined ? { isActive: updates.isActive } : {}),
    });
    if (!row) throw new Error(`Tax category ${id} not found`);

    const updated = toTaxCategory(row);
    void broadcastRealtime('tax_category_update', { type: 'updated', taxCategory: updated });
    return updated;
  }

  static async remove(id: string): Promise<boolean> {
    const deleted = await repo().deleteTaxCategory(id);
    if (deleted) {
      void broadcastRealtime('tax_category_update', { type: 'deleted', taxCategoryId: id });
    }
    return deleted;
  }

  static async setDefault(id: string): Promise<TaxCategory> {
    const catalog = repo();
    const row = await catalog.updateTaxCategory(id, { isDefault: true });
    if (!row) throw new Error(`Tax category ${id} not found`);
    await catalog.clearDefaultTaxCategory(id);
    void broadcastRealtime('tax_category_update', { type: 'default_changed', taxCategoryId: id });
    return toTaxCategory(row);
  }

  static async clearAll(): Promise<number> {
    const before = (await repo().listTaxCategories()).length;
    await repo().deleteAllTaxCategories();
    return before;
  }
}
