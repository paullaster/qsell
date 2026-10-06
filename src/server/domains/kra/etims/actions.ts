'use server';

import { revalidatePath } from 'next/cache';
import { inArray } from 'drizzle-orm';
import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { products, type EtimsItemRow } from '@/server/db/drizzle/schema';
import { KraConfigError } from '../types';
import {
  EtimsItemError,
  type EtimsTargetView,
  type ProductEtimsOverview,
  type RegistrableProduct,
  type RemoteEtimsItem,
} from './item-service';
import { EtimsApiError } from './client';

const ITEMS_PATH = '/admin/settings/tax-compliance/kra-tims-etims/items';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Server action errors are masked in production, so failures come back as data. */
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error: unknown) {
    if (
      error instanceof KraConfigError ||
      error instanceof EtimsItemError ||
      error instanceof EtimsApiError
    ) {
      return { ok: false, error: error.message };
    }
    console.error('[etims-items]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

async function companyId(): Promise<string> {
  return (await getContainer().companySettings.ensureSeeded()).id;
}

export interface EtimsItemView {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  kraItemCode: string | null;
  status: EtimsItemRow['status'];
  taxCode: string;
  qtyUnitCode: string;
  pkgUnitCode: string;
  itemClassCode: string;
  unitPrice: number;
  stockQuantity: number;
  errorMessage: string | null;
  lastSyncedAt: string | null;
}

export interface EtimsItems {
  items: EtimsItemView[];
  registrable: RegistrableProduct[];
}

export async function listEtimsItemsAction(
  branchId: string | null,
): Promise<ActionResult<EtimsItems>> {
  await requirePermission('taxes:manage');
  return run(async () => {
    const svc = getContainer().etimsItems;
    const target = { companyId: await companyId(), branchId };
    const [rows, registrable] = await Promise.all([
      svc.listLocal(target),
      svc.listRegistrable(target),
    ]);
    const ids = rows.map((r) => r.productId);
    const names = ids.length
      ? await getContainer()
          .db.select({ id: products.id, name: products.name, sku: products.sku })
          .from(products)
          .where(inArray(products.id, ids))
      : [];
    const byId = new Map(names.map((n) => [n.id, n]));
    return {
      registrable,
      items: rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        productName: byId.get(r.productId)?.name ?? r.name,
        sku: byId.get(r.productId)?.sku ?? '',
        kraItemCode: r.kraItemCode,
        status: r.status,
        taxCode: r.taxCode,
        qtyUnitCode: r.qtyUnitCode,
        pkgUnitCode: r.pkgUnitCode,
        itemClassCode: r.itemClassCode,
        unitPrice: Number(r.unitPrice),
        stockQuantity: r.stockQuantity,
        errorMessage: r.errorMessage,
        lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      })),
    };
  });
}

export async function listRemoteEtimsItemsAction(
  branchId: string | null,
): Promise<ActionResult<RemoteEtimsItem[]>> {
  await requirePermission('taxes:manage');
  return run(async () =>
    getContainer().etimsItems.listRemote({ companyId: await companyId(), branchId }),
  );
}

/** Where eTIMS items can be managed: the company and independent branches in eTIMS mode. */
export async function listEtimsTargetsAction(): Promise<ActionResult<EtimsTargetView[]>> {
  await requirePermission('taxes:manage');
  return run(async () => {
    const { companySettings, branches, etimsItems } = getContainer();
    const company = await companySettings.ensureSeeded();
    return etimsItems.listTargets({
      companyId: company.id,
      branches: await branches.listByCompany(company.id),
    });
  });
}

export async function registerEtimsItemAction(input: {
  /** Null or omitted manages the company's items; a branch id only works for independent branches. */
  branchId?: string | null;
  productId: string;
  qtyUnitCode: string;
  pkgUnitCode: string;
  itemClassCode: string;
  orgCountryCode?: string;
  initialStock?: number;
}): Promise<ActionResult<{ id: string; status: string }>> {
  await requirePermission('taxes:manage');
  return run(async () => {
    const row = await getContainer().etimsItems.register({
      ...input,
      companyId: await companyId(),
    });
    revalidatePath(ITEMS_PATH);
    return { id: row.id, status: row.status };
  });
}

export async function updateEtimsItemAction(input: {
  /** Null or omitted manages the company's items; a branch id only works for independent branches. */
  branchId?: string | null;
  productId: string;
  qtyUnitCode?: string;
  pkgUnitCode?: string;
  itemClassCode?: string;
  stock?: number;
}): Promise<ActionResult<{ id: string }>> {
  await requirePermission('taxes:manage');
  return run(async () => {
    const row = await getContainer().etimsItems.update({ ...input, companyId: await companyId() });
    revalidatePath(ITEMS_PATH);
    return { id: row.id };
  });
}

export async function updateEtimsStockAction(input: {
  /** Null or omitted manages the company's items; a branch id only works for independent branches. */
  branchId?: string | null;
  productId: string;
  quantity: number;
}): Promise<ActionResult<{ id: string }>> {
  await requirePermission('taxes:manage');
  return run(async () => {
    const row = await getContainer().etimsItems.updateStock({
      ...input,
      companyId: await companyId(),
    });
    revalidatePath(ITEMS_PATH);
    return { id: row.id };
  });
}

export async function removeEtimsItemAction(input: {
  /** Null or omitted manages the company's items; a branch id only works for independent branches. */
  branchId?: string | null;
  productId: string;
}): Promise<ActionResult<{ id: string }>> {
  await requirePermission('taxes:manage');
  return run(async () => {
    const row = await getContainer().etimsItems.remove({ ...input, companyId: await companyId() });
    revalidatePath(ITEMS_PATH);
    return { id: row.id };
  });
}

export async function reconcileEtimsItemAction(input: {
  /** Null or omitted manages the company's items; a branch id only works for independent branches. */
  branchId?: string | null;
  productId: string;
}): Promise<ActionResult<{ id: string; status: string }>> {
  await requirePermission('taxes:manage');
  return run(async () => {
    const row = await getContainer().etimsItems.reconcile({
      ...input,
      companyId: await companyId(),
    });
    revalidatePath(ITEMS_PATH);
    return { id: row.id, status: row.status };
  });
}

export async function getProductEtimsAction(
  productId: string,
): Promise<ActionResult<ProductEtimsOverview>> {
  await requirePermission('taxes:manage');
  return run(async () => {
    const { companySettings, branches, etimsItems } = getContainer();
    const company = await companySettings.ensureSeeded();
    return etimsItems.overviewForProduct({
      companyId: company.id,
      productId,
      branches: await branches.listByCompany(company.id),
    });
  });
}
