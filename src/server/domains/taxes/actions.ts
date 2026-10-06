'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { TaxDomainService } from './service';
import type { TaxCategory } from '@/types/index';

const TAX_PAGE = '/admin/settings/tax-compliance/kra-tims-etims/classification';

export async function listTaxCategoriesAction(): Promise<TaxCategory[]> {
  await requirePermission('products:read');
  return TaxDomainService.getAll();
}

export async function createTaxCategoryAction(
  data: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
): Promise<TaxCategory> {
  await requirePermission('taxes:manage');
  const tax = await TaxDomainService.create(data);
  revalidatePath(TAX_PAGE);
  revalidatePath('/admin/products');
  return tax;
}

export async function updateTaxCategoryAction(
  id: string,
  updates: Partial<TaxCategory>,
): Promise<TaxCategory> {
  await requirePermission('taxes:manage');
  const tax = await TaxDomainService.update(id, updates);
  revalidatePath(TAX_PAGE);
  return tax;
}

export async function deleteTaxCategoryAction(id: string): Promise<boolean> {
  await requirePermission('taxes:manage');
  const ok = await TaxDomainService.remove(id);
  revalidatePath(TAX_PAGE);
  return ok;
}

export async function setDefaultTaxCategoryAction(id: string): Promise<TaxCategory> {
  await requirePermission('taxes:manage');
  const tax = await TaxDomainService.setDefault(id);
  revalidatePath(TAX_PAGE);
  return tax;
}

export async function clearTaxCategoriesAction(): Promise<{ cleared: number }> {
  await requirePermission('taxes:manage');
  const cleared = await TaxDomainService.clearAll();
  revalidatePath(TAX_PAGE);
  return { cleared };
}
