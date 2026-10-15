'use server';

import { getContainer } from '@/server/di/container';
import { runSetting, type SettingsResult } from '@/server/domains/settings/action-runner';
import type { PageInput } from '@/server/domains/settings/paging';
import type { EtimsItemRow } from '@/server/db/drizzle/schema';
import { KraConfigError } from '../types';
import { EtimsItemError, type EtimsTargetView, type ProductEtimsOverview, type RemoteEtimsItem } from './item-service';
import { EtimsApiError } from './client';

const ITEMS_PATH = '/admin/settings/tax-compliance/kra-tims-etims/items';

export type ActionResult<T> = SettingsResult<T>;

/** Failures that come with words for the person (a refusal by KRA, a missing setting, a rule). */
const friendly = (error: unknown): string | null => (error instanceof KraConfigError || error instanceof EtimsItemError || error instanceof EtimsApiError ? error.message : null);

/** Every eTIMS action: one explicit permission, failures returned as data. */
const run = <T,>(fn: (companyId: string) => Promise<T>, paths: string[] = []) => runSetting('taxes:manage', ({ companyId }) => fn(companyId), { paths, friendly });

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

export interface EtimsItemsPage {
  rows: EtimsItemView[];
  nextCursor: string | null;
}

/** One page of the items registered in a scope (the company, or an independent branch), found by name or KRA code. */
export async function etimsItemsPageAction(input: PageInput & { branchId: string | null }): Promise<ActionResult<EtimsItemsPage>> {
  return run(async (companyId) => {
    const svc = getContainer().etimsItems;
    const page = await svc.pageLocal({ companyId, branchId: input.branchId }, input);
    const facts = await svc.productFacts(page.rows.map((r) => r.productId));
    return {
      nextCursor: page.nextCursor,
      rows: page.rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        productName: facts.get(r.productId)?.name ?? r.name,
        sku: facts.get(r.productId)?.sku ?? '',
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

/** The items KRA itself holds for a scope, tagged with the local item each matches. */
export async function listRemoteEtimsItemsAction(branchId: string | null): Promise<ActionResult<RemoteEtimsItem[]>> {
  return run((companyId) => getContainer().etimsItems.listRemote({ companyId, branchId }));
}

/** Where eTIMS items can be managed: the company and independent branches in eTIMS mode. */
export async function listEtimsTargetsAction(): Promise<ActionResult<EtimsTargetView[]>> {
  return run(async (companyId) => {
    const { branches, etimsItems } = getContainer();
    return etimsItems.listTargets({ companyId, branches: await branches.listByCompany(companyId) });
  });
}

/** Null or omitted manages the company's items; a branch id only works for independent branches. */
interface ScopeInput {
  branchId?: string | null;
  productId: string;
}

export async function registerEtimsItemAction(input: ScopeInput & { qtyUnitCode: string; pkgUnitCode: string; itemClassCode: string; orgCountryCode?: string; initialStock?: number }): Promise<ActionResult<{ id: string; status: string }>> {
  return run(
    async (companyId) => {
      const row = await getContainer().etimsItems.register({ ...input, companyId });
      return { id: row.id, status: row.status };
    },
    [ITEMS_PATH],
  );
}

export async function updateEtimsItemAction(input: ScopeInput & { qtyUnitCode?: string; pkgUnitCode?: string; itemClassCode?: string; stock?: number }): Promise<ActionResult<{ id: string }>> {
  return run(
    async (companyId) => {
      const row = await getContainer().etimsItems.update({ ...input, companyId });
      return { id: row.id };
    },
    [ITEMS_PATH],
  );
}

export async function updateEtimsStockAction(input: ScopeInput & { quantity: number }): Promise<ActionResult<{ id: string }>> {
  return run(
    async (companyId) => {
      const row = await getContainer().etimsItems.updateStock({ ...input, companyId });
      return { id: row.id };
    },
    [ITEMS_PATH],
  );
}

export async function removeEtimsItemAction(input: ScopeInput): Promise<ActionResult<{ id: string }>> {
  return run(
    async (companyId) => {
      const row = await getContainer().etimsItems.remove({ ...input, companyId });
      return { id: row.id };
    },
    [ITEMS_PATH],
  );
}

export async function reconcileEtimsItemAction(input: ScopeInput): Promise<ActionResult<{ id: string; status: string }>> {
  return run(
    async (companyId) => {
      const row = await getContainer().etimsItems.reconcile({ ...input, companyId });
      return { id: row.id, status: row.status };
    },
    [ITEMS_PATH],
  );
}

export async function getProductEtimsAction(productId: string): Promise<ActionResult<ProductEtimsOverview>> {
  return run(async (companyId) => {
    const { branches, etimsItems } = getContainer();
    return etimsItems.overviewForProduct({ companyId, productId, branches: await branches.listByCompany(companyId) });
  });
}
