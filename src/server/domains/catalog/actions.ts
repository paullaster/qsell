'use server';

import { revalidatePath } from 'next/cache';
import { CatalogService } from './service';
import type { Product, Category, ItemType } from '@/types/index';

export async function listProductsAction(): Promise<Product[]> {
  return CatalogService.getAllProducts();
}

/** Active, sellable catalog for the customer storefront. */
export async function listSellableProductsAction(): Promise<Product[]> {
  return CatalogService.getSellableProducts();
}

export async function getProductAction(id: string): Promise<Product | null> {
  return CatalogService.getProductById(id) ?? null;
}

export async function createProductAction(
  productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'reservedQuantity'>,
): Promise<Product> {
  const product = CatalogService.createProduct(productData);
  revalidatePath('/admin/products');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return product;
}

export async function updateProductAction(id: string, updates: Partial<Product>): Promise<Product> {
  const product = CatalogService.updateProduct(id, updates);
  revalidatePath('/admin/products');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  revalidatePath(`/product/${id}`);
  return product;
}

export async function deleteProductAction(id: string): Promise<boolean> {
  const ok = CatalogService.deleteProduct(id);
  revalidatePath('/admin/products');
  revalidatePath('/');
  return ok;
}

export async function listCategoriesAction(): Promise<Category[]> {
  return CatalogService.getAllCategories();
}

export async function createCategoryAction(
  data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>,
): Promise<Category> {
  const category = CatalogService.createCategory(data);
  revalidatePath('/admin/categories');
  revalidatePath('/');
  return category;
}

export async function updateCategoryAction(
  id: string,
  updates: Partial<Category>,
): Promise<Category> {
  const category = CatalogService.updateCategory(id, updates);
  revalidatePath('/admin/categories');
  revalidatePath('/');
  return category;
}

export async function deleteCategoryAction(id: string): Promise<{
  deleted: boolean;
  reassignedCount: number;
  fallbackName: string | null;
}> {
  const result = CatalogService.deleteCategory(id);
  if (!result.deleted) {
    throw new Error('Failed to delete category');
  }
  revalidatePath('/admin/categories');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return result;
}

export async function listItemTypesAction(): Promise<ItemType[]> {
  return CatalogService.getAllItemTypes();
}

export async function createItemTypeAction(data: {
  name: string;
  code: number;
  isSellable: boolean;
  isDefault?: boolean;
  isActive?: boolean;
}): Promise<ItemType> {
  const itemType = CatalogService.createItemType(data);
  revalidatePath('/admin/item-types');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return itemType;
}

export async function updateItemTypeAction(
  id: string,
  updates: Partial<Pick<ItemType, 'name' | 'code' | 'isSellable' | 'isDefault' | 'isActive'>>,
): Promise<ItemType> {
  const itemType = CatalogService.updateItemType(id, updates);
  revalidatePath('/admin/item-types');
  revalidatePath('/admin/products');
  revalidatePath('/');
  return itemType;
}

export async function setDefaultItemTypeAction(id: string): Promise<ItemType> {
  const itemType = CatalogService.setDefaultItemType(id);
  revalidatePath('/admin/item-types');
  revalidatePath('/admin/products');
  return itemType;
}

export async function deleteItemTypeAction(id: string): Promise<boolean> {
  const ok = CatalogService.deleteItemType(id);
  if (!ok) throw new Error('Failed to delete item type');
  revalidatePath('/admin/item-types');
  revalidatePath('/admin/products');
  return ok;
}
