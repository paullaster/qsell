'use server';

import { revalidatePath } from 'next/cache';
import { CurrencyDomainService } from './service';
import type { CurrencyConfig } from '@/types/index';

export async function listCurrenciesAction(): Promise<CurrencyConfig[]> {
  return CurrencyDomainService.getAll();
}

export async function createCurrencyAction(data: CurrencyConfig): Promise<CurrencyConfig> {
  const currency = await CurrencyDomainService.create(data);
  revalidatePath('/admin/currencies');
  return currency;
}

export async function updateCurrencyAction(
  code: string,
  updates: Partial<CurrencyConfig>,
): Promise<CurrencyConfig> {
  const currency = await CurrencyDomainService.update(code, updates);
  revalidatePath('/admin/currencies');
  return currency;
}

export async function deleteCurrencyAction(code: string): Promise<boolean> {
  const ok = await CurrencyDomainService.remove(code);
  revalidatePath('/admin/currencies');
  return ok;
}

export async function setBaseCurrencyAction(code: string): Promise<CurrencyConfig> {
  const currency = await CurrencyDomainService.setBase(code);
  revalidatePath('/admin/currencies');
  return currency;
}
