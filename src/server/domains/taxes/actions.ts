'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { runSetting, SettingsError } from '@/server/domains/settings/action-runner';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import type { PageInput } from '@/server/domains/settings/paging';
import { toTaxCategory } from '@/server/domains/catalog/mappers';
import { TaxDomainService } from './service';
import type { TaxCategory } from '@/types/index';

const TAX_PAGE = '/admin/settings/tax-compliance/kra-tims-etims/classification';

export async function listTaxCategoriesAction(): Promise<TaxCategory[]> {
  await requirePermission('products:read');
  return TaxDomainService.getAll();
}


/** A rule failing a KRA code check or similar: the message is meant for the person. */
const friendly = (error: unknown): string | null => {
  if (isUniqueViolation(error)) return 'A tax rule with that code already exists.';
  return error instanceof Error && /^Invalid KRA|not found$/.test(error.message) ? error.message : null;
};

const PATHS = [TAX_PAGE, '/admin/products'];

export interface TaxSummary {
  total: number;
  active: number;
  countries: number;
  defaultRule: TaxCategory | null;
}

/** One page of tax rules, narrowed by text, type and pricing model. */
export async function taxCategoriesPageAction(input: PageInput & { type?: string; inclusive?: boolean }) {
  return runSetting('taxes:manage', async () => {
    const page = await getContainer().catalog.pageTaxCategories(input);
    return { rows: page.rows.map((r) => toTaxCategory(r, r.productCount)), nextCursor: page.nextCursor };
  });
}

/** The default rule and the counts for the summary cards. */
export async function taxSummaryAction() {
  return runSetting('taxes:manage', async (): Promise<TaxSummary> => {
    const s = await getContainer().catalog.taxSummary();
    return { total: s.total, active: s.active, countries: s.countries, defaultRule: s.defaultRule === null ? null : toTaxCategory(s.defaultRule) };
  });
}

export async function createTaxCategoryAction(data: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>) {
  return runSetting('taxes:manage', () => TaxDomainService.create(data), { paths: PATHS, friendly });
}

export async function updateTaxCategoryAction(id: string, updates: Partial<TaxCategory>) {
  return runSetting('taxes:manage', () => TaxDomainService.update(id, updates), { paths: PATHS, friendly });
}

export async function deleteTaxCategoryAction(id: string) {
  return runSetting(
    'taxes:manage',
    async () => {
      const row = await getContainer().catalog.getTaxCategoryById(id);
      if (row === null) throw new SettingsError('That tax rule does not exist.', 'NOT_FOUND');
      if (row.isDefault) throw new SettingsError('The default rule cannot be deleted. Make another rule the default first.');
      return { deleted: await TaxDomainService.remove(id) };
    },
    { paths: PATHS, friendly },
  );
}

export async function setDefaultTaxCategoryAction(id: string) {
  return runSetting('taxes:manage', () => TaxDomainService.setDefault(id), { paths: PATHS, friendly });
}
