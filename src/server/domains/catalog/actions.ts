'use server';

import { AccessDeniedError, requirePermission } from '@/server/domains/access-control/guard';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { buildProductTemplateCsv, MAX_IMPORT_BYTES } from '@/lib/productCsv';
import { CatalogService } from './service';
import {
  BulkDeleteError,
  ProductBulkDelete,
  type DeletePreview,
  type DeleteResult,
  type ProductSelection,
} from './bulk-delete';
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
  return CatalogService.getSellableProducts();
}

/** Staff lookup — returns the full record, including cost. */
export async function getProductAction(id: string): Promise<Product | null> {
  await requirePermission('products:read');
  return (await CatalogService.getProductWithMedia(id)) ?? null;
}

/** Public lookup — published, sellable products only, without staff-only fields. */
export async function getPublicProductAction(id: string): Promise<PublicProduct | null> {
  return (await CatalogService.getPublicProduct(id)) ?? null;
}

export async function createProductAction(productData: ProductWrite): Promise<Product> {
  await requirePermission('products:create');
  const product = await CatalogService.createProduct(productData);
  revalidatePath('/admin/products');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return product;
}

export async function updateProductAction(id: string, updates: ProductPatch): Promise<Product> {
  await requirePermission('products:update');
  const product = await CatalogService.updateProduct(id, updates);
  revalidatePath('/admin/products');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  revalidatePath(`/product/${id}`);
  return product;
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
): Promise<BulkDeleteOutcome<DeletePreview>> {
  try {
    await requirePermission(permanent ? 'products:delete_permanently' : 'products:delete');
    return { ok: true, data: await ProductBulkDelete.preview(selection, permanent) };
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
  opts: { permanent: boolean; expectedCount: number; reason?: string },
): Promise<BulkDeleteOutcome<DeleteResult>> {
  try {
    const actorId = await requirePermission(
      opts.permanent ? 'products:delete_permanently' : 'products:delete',
    );
    const result = await ProductBulkDelete.delete(selection, { ...opts, actorId });
    revalidatePath('/admin/products');
    revalidatePath('/admin/inventory');
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
  return { ok: false, error: 'The products could not be deleted. Nothing further was changed.' };
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
