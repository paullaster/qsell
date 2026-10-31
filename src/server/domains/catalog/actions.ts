'use server';

import { withShopAvailability } from './shop-availability';
import { AccessDeniedError, requirePermission } from '@/server/domains/access-control/guard';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { buildProductTemplateCsv, MAX_IMPORT_BYTES } from '@/lib/productCsv';
import { CatalogService } from './service';
import { optionalAmount } from './commercial-rules';
import { SettingsError } from '@/server/domains/settings/errors';
import { runSetting } from '@/server/domains/settings/action-runner';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { unitConflictWords } from '@/server/domains/units/write-service';
import {
  BulkDeleteError,
  ProductBulkDelete,
  type DeletePreview,
  type DeleteResult,
  type DeleteScope,
  type ProductSelection,
} from './bulk-delete';
import { ProductBulkStatus, type StatusResult } from './bulk-status';
import { ProductTrash, type RestoreResult, type TrashPage } from './trash';
import type { ImportJobView, StageResult } from './import-service';
import type {
  Product,
  ProductPatch,
  ProductWrite,
  PublicProduct,
  Category,
  ItemType,
} from '@/types/index';

export async function listProductsAction(): Promise<Product[]> {
  await requirePermission('products:read');
  return CatalogService.getAllProducts();
}

/** Active, sellable catalog for the customer storefront. */
export async function listSellableProductsAction(): Promise<PublicProduct[]> {
  return await withShopAvailability(await CatalogService.getSellableProducts());
}

/** Staff lookup — returns the full record, including cost. */
export async function getProductAction(id: string): Promise<Product | null> {
  await requirePermission('products:read');
  return (await CatalogService.getProductWithMedia(id)) ?? null;
}

/** Public lookup — published, sellable products only, without staff-only fields. */
export async function getPublicProductAction(id: string): Promise<PublicProduct | null> {
  const product = await CatalogService.getPublicProduct(id);
  return product === undefined ? null : ((await withShopAvailability([product]))[0] ?? null);
}

/** A product rule that was not met, or a code or slug already taken, in words for the person. */
const productFriendly = (error: unknown): string | null =>
  isUniqueViolation(error) ? 'That SKU, stock code or URL slug is already used by another product.' : unitConflictWords(error);

const PRODUCT_PATHS = ['/admin/products', '/admin/inventory', '/'];

/** Failures come back as data: the text of a thrown server action is masked in production. */
/** Setting or changing the standard price is its own permission: saving the rest of the product does not need it. */
async function mayChangeStandardPrice(): Promise<void> {
  try {
    await requirePermission('products:set_standard_price');
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      throw new SettingsError('Changing the standard price needs the "Set standard price" permission. Ask an administrator, or leave the standard price as it is.');
    }
    throw error;
  }
}

export async function createProductAction(productData: ProductWrite) {
  return runSetting('products:create', async () => {
    if (optionalAmount(productData.standardPrice) !== null) await mayChangeStandardPrice();
    return await CatalogService.createProduct(productData);
  }, { paths: PRODUCT_PATHS, friendly: productFriendly });
}

export async function updateProductAction(id: string, updates: ProductPatch) {
  return runSetting('products:update', async () => {
    if (updates.standardPrice !== undefined) {
      const current = await CatalogService.getProductById(id);
      // Only a different value needs the permission, so a form that sends every field back unchanged saves for anyone who may edit.
      if ((optionalAmount(updates.standardPrice) ?? null) !== (current?.standardPrice ?? null)) await mayChangeStandardPrice();
    }
    return await CatalogService.updateProduct(id, updates);
  }, { paths: PRODUCT_PATHS, friendly: productFriendly });
}

export async function deleteProductAction(id: string): Promise<boolean> {
  await requirePermission('products:delete');
  const ok = await CatalogService.deleteProduct(id);
  revalidatePath('/admin/products');
  revalidatePath('/');
  return ok;
}

export type BulkDeleteOutcome<T> =
  { ok: true; data: T } | { ok: false; error: string; code?: string; forbidden?: true };

/** What a delete would do, shown in the confirmation before anything happens. */
export async function previewProductDeleteAction(
  selection: ProductSelection,
  permanent: boolean,
  scope: DeleteScope = 'live',
): Promise<BulkDeleteOutcome<DeletePreview>> {
  try {
    await requirePermission(permanent ? 'products:delete_permanently' : 'products:delete');
    return { ok: true, data: await ProductBulkDelete.preview(selection, permanent, scope) };
  } catch (error: unknown) {
    return deleteFailure(error);
  }
}

/**
 * Deletes the selected products: soft by default (stock history kept, SKU freed), or permanently,
 * which needs its own permission and a reason, and is refused for products history depends on.
 * `expectedCount` is the number the person confirmed; a different result deletes nothing.
 */
export async function deleteProductsAction(
  selection: ProductSelection,
  opts: { permanent: boolean; expectedCount: number; reason?: string; scope?: DeleteScope },
): Promise<BulkDeleteOutcome<DeleteResult>> {
  try {
    const actorId = await requirePermission(
      opts.permanent ? 'products:delete_permanently' : 'products:delete',
    );
    const result = await ProductBulkDelete.delete(selection, { ...opts, actorId });
    revalidatePath('/admin/products');
    revalidatePath('/admin/trash/products');
    revalidatePath('/admin/inventory');
    revalidatePath('/');
    return { ok: true, data: result };
  } catch (error: unknown) {
    return deleteFailure(error);
  }
}

/** Publishes (active) or hides (draft) the selected products in one go. */
export async function setProductsActiveAction(
  selection: ProductSelection,
  active: boolean,
  expectedCount: number,
): Promise<BulkDeleteOutcome<StatusResult>> {
  try {
    const actorId = await requirePermission('products:update');
    const result = await ProductBulkStatus.set(selection, active, { expectedCount, actorId });
    revalidatePath('/admin/products');
    revalidatePath('/');
    return { ok: true, data: result };
  } catch (error: unknown) {
    return deleteFailure(error);
  }
}

/** Deleted products, newest first, for the Trash screen. */
export async function listTrashAction(opts: {
  search?: string;
  page?: number;
}): Promise<BulkDeleteOutcome<TrashPage>> {
  try {
    await requirePermission('products:delete');
    return { ok: true, data: await ProductTrash.list(opts) };
  } catch (error: unknown) {
    return deleteFailure(error);
  }
}

export async function trashCountAction(): Promise<number> {
  try {
    await requirePermission('products:delete');
    return await ProductTrash.count();
  } catch {
    return 0;
  }
}

/** Brings the selected products back from the trash, as drafts. */
export async function restoreProductsAction(
  selection: ProductSelection,
  expectedCount: number,
): Promise<BulkDeleteOutcome<RestoreResult>> {
  try {
    const actorId = await requirePermission('products:delete');
    const result = await ProductTrash.restore(selection, { expectedCount, actorId });
    revalidatePath('/admin/products');
    revalidatePath('/admin/trash/products');
    revalidatePath('/');
    return { ok: true, data: result };
  } catch (error: unknown) {
    return deleteFailure(error);
  }
}

function deleteFailure(error: unknown): {
  ok: false;
  error: string;
  code?: string;
  forbidden?: true;
} {
  if (error instanceof BulkDeleteError)
    return { ok: false, error: error.message, code: error.code };
  if (error instanceof AccessDeniedError)
    return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
  Sentry.captureException(error);
  return { ok: false, error: 'The change could not be completed. Nothing further was changed.' };
}

export async function listCategoriesAction(): Promise<Category[]> {
  await requirePermission('products:read');
  return CatalogService.getAllCategories();
}

export async function createCategoryAction(
  data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
): Promise<Category> {
  await requirePermission('products:create');
  const category = await CatalogService.createCategory(data);
  revalidatePath('/admin/categories');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return category;
}

export async function updateCategoryAction(
  id: string,
  updates: Partial<Category>,
): Promise<Category> {
  await requirePermission('products:update');
  const category = await CatalogService.updateCategory(id, updates);
  revalidatePath('/admin/categories');
  revalidatePath('/');
  return category;
}

export async function deleteCategoryAction(id: string): Promise<{
  deleted: boolean;
  reassignedCount: number;
  fallbackName: string | null;
}> {
  await requirePermission('products:delete');
  const result = await CatalogService.deleteCategory(id);
  if (!result.deleted) {
    throw new Error('Failed to delete category');
  }
  revalidatePath('/admin/categories');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return result;
}

export async function listItemTypesAction(): Promise<ItemType[]> {
  await requirePermission('products:read');
  return CatalogService.getAllItemTypes();
}

export async function createItemTypeAction(data: {
  name: string;
  code: number;
  isSellable: boolean;
  isDefault?: boolean;
  isActive?: boolean;
}): Promise<ItemType> {
  await requirePermission('products:create');
  const itemType = await CatalogService.createItemType(data);
  revalidatePath('/admin/item-types');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return itemType;
}

export async function updateItemTypeAction(
  id: string,
  updates: Partial<Pick<ItemType, 'name' | 'code' | 'isSellable' | 'isDefault' | 'isActive'>>,
): Promise<ItemType> {
  await requirePermission('products:update');
  const itemType = await CatalogService.updateItemType(id, updates);
  revalidatePath('/admin/item-types');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return itemType;
}

export async function setDefaultItemTypeAction(id: string): Promise<ItemType> {
  await requirePermission('products:update');
  const itemType = await CatalogService.setDefaultItemType(id);
  revalidatePath('/admin/item-types');
  revalidatePath('/admin/products');
  return itemType;
}

export async function deleteItemTypeAction(id: string): Promise<boolean> {
  await requirePermission('products:delete');
  const ok = await CatalogService.deleteItemType(id);
  if (!ok) throw new Error('Failed to delete item type');
  revalidatePath('/admin/item-types');
  revalidatePath('/admin/products');
  return ok;
}

// ── Bulk CSV import ─────────────────────────────────────────────────────────

/**
 * Validate an uploaded CSV and, if every row is valid, queue it for the worker.
 * Returns every problem found when the file is rejected; nothing is imported then.
 */
export async function startProductImportAction(formData: FormData): Promise<StageResult> {
  const userId = await requirePermission('products:create');
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return {
      ok: false,
      problems: [{ row: null, column: null, message: 'Choose a CSV file to upload.' }],
      rowsWithProblems: 0,
      totalRows: 0,
    };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      problems: [
        {
          row: null,
          column: null,
          message: `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Split it into smaller files.`,
        },
      ],
      rowsWithProblems: 0,
      totalRows: 0,
    };
  }
  if (!/\.csv$/i.test(file.name)) {
    return {
      ok: false,
      problems: [{ row: null, column: null, message: 'Upload a .csv file.' }],
      rowsWithProblems: 0,
      totalRows: 0,
    };
  }
  const session = await auth();
  try {
    return await getContainer().productImports.stage({
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      actor: { id: userId, email: session?.user.email ?? '' },
    });
  } catch (error) {
    // Never show raw database errors (they carry SQL and parameters) — report and give a reference.
    const reference = reportImportFailure(error, 'start');
    return {
      ok: false,
      problems: [
        {
          row: null,
          column: null,
          message: `The import could not be started. Nothing was imported. Please try again; if it keeps failing, contact support with reference ${reference}.`,
        },
      ],
      rowsWithProblems: 0,
      totalRows: 0,
    };
  }
}

function reportImportFailure(error: unknown, action: string): string {
  const reference = randomUUID();
  console.error(`[catalog.import.${action}] failed`, { reference, error });
  Sentry.captureException(error, {
    tags: { area: 'catalog', action: `import_${action}` },
    extra: { reference },
  });
  return reference;
}

export async function getProductImportAction(jobId: string): Promise<ImportJobView | null> {
  await requirePermission('products:read');
  return await getContainer().productImports.getJob(jobId);
}

export async function listProductImportsAction(): Promise<ImportJobView[]> {
  await requirePermission('products:read');
  return await getContainer().productImports.listRecent(5);
}

export async function retryProductImportAction(jobId: string): Promise<boolean> {
  await requirePermission('products:create');
  try {
    return await getContainer().productImports.retry(jobId);
  } catch (error) {
    const reference = reportImportFailure(error, 'retry');
    throw new Error(`The import could not be restarted. Reference ${reference}.`, {
      cause: error,
    });
  }
}

/** Rows that failed while importing, with reasons, as CSV text. */
export async function productImportFailuresCsvAction(jobId: string): Promise<string> {
  await requirePermission('products:read');
  return await getContainer().productImports.failedRowsCsv(jobId);
}

/** Import template pre-filled with real category / item type / tax names. */
export async function productImportTemplateCsvAction(): Promise<string> {
  await requirePermission('products:read');
  return buildProductTemplateCsv(await getContainer().productImports.templateExamples());
}
