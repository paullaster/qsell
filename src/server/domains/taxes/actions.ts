'use server';

import { revalidatePath } from 'next/cache';
import { TaxDomainService } from './service';
import type { TaxCategory } from '@/types/index';

export async function listTaxCategoriesAction(): Promise<TaxCategory[]> {
  return TaxDomainService.getAll();
}

export async function createTaxCategoryAction(
  data: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
): Promise<TaxCategory> {
  const tax = TaxDomainService.create(data);
  revalidatePath('/admin/taxes');
  revalidatePath('/admin/products');
  return tax;
}

export async function updateTaxCategoryAction(
  id: string,
  updates: Partial<TaxCategory>,
): Promise<TaxCategory> {
  const tax = TaxDomainService.update(id, updates);
  revalidatePath('/admin/taxes');
  return tax;
}

export async function deleteTaxCategoryAction(id: string): Promise<boolean> {
  const ok = TaxDomainService.remove(id);
  revalidatePath('/admin/taxes');
  return ok;
}

export async function setDefaultTaxCategoryAction(id: string): Promise<TaxCategory> {
  const tax = TaxDomainService.setDefault(id);
  revalidatePath('/admin/taxes');
  return tax;
}

export async function clearTaxCategoriesAction(): Promise<{ cleared: number }> {
  const cleared = TaxDomainService.clearAll();
  revalidatePath('/admin/taxes');
  return { cleared };
}
