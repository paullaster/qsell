import type { Choice } from '@/lib/payment-options';

export type EtimsStatus = 'registered' | 'pending' | 'unconfirmed' | 'failed' | 'deleted';

export const STATUS_TONE: Record<EtimsStatus, 'green' | 'amber' | 'red' | 'gray'> = {
  registered: 'green',
  pending: 'amber',
  unconfirmed: 'amber',
  failed: 'red',
  deleted: 'gray',
};

/** "company" for the company's items, otherwise the id of an independent branch. */
export const scopeKey = (t: { scope: 'company' | 'branch'; branchId: string | null }): string => (t.scope === 'company' ? 'company' : (t.branchId ?? ''));

/** The branch id a scope key stands for; null is the company. */
export const branchOfScope = (key: string): string | null => (key === 'company' || key === '' ? null : key);

export interface RegisterForm {
  qtyUnitCode: string;
  pkgUnitCode: string;
  itemClassCode: string;
  stock: string;
}

export const emptyRegisterForm = (): RegisterForm => ({ qtyUnitCode: '', pkgUnitCode: '', itemClassCode: '', stock: '0' });

/** The form filled from the product just chosen: the codes it was registered with before, and its stock. */
export function registerFormFor(product: Choice | null): RegisterForm {
  const m = product?.meta;
  if (m === undefined) return emptyRegisterForm();
  return { qtyUnitCode: m.qtyUnitCode ?? '', pkgUnitCode: m.pkgUnitCode ?? '', itemClassCode: m.itemClassCode ?? '', stock: m.stock ?? '0' };
}

/** A product with no eTIMS tax code cannot be registered; the server says so on the option. */
export const canRegister = (product: Choice | null): boolean => product !== null && product.meta?.taxCode === '1';

export function registerPayload(branchId: string | null, product: Choice, form: RegisterForm):
  | { ok: true; payload: { branchId: string | null; productId: string; qtyUnitCode: string; pkgUnitCode: string; itemClassCode: string; initialStock: number } }
  | { ok: false; error: string } {
  const stock = Number(form.stock);
  if (!Number.isInteger(stock) || stock < 0) return { ok: false, error: 'The opening stock is a whole number, zero or more.' };
  const [qty, pkg, cls] = [form.qtyUnitCode.trim(), form.pkgUnitCode.trim(), form.itemClassCode.trim()];
  if (qty === '' || pkg === '' || cls === '') return { ok: false, error: 'Give the quantity unit, package unit and classification codes.' };
  return { ok: true, payload: { branchId, productId: product.id, qtyUnitCode: qty, pkgUnitCode: pkg, itemClassCode: cls, initialStock: stock } };
}

/** Whether the stock typed differs from what KRA holds and is a whole number. */
export const stockChanged = (typed: string, current: number): boolean => typed !== '' && Number.isInteger(Number(typed)) && Number(typed) !== current;
