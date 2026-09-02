'use server';

import { revalidatePath } from 'next/cache';
import { CatalogService } from './service';
import type { Product, Category } from '@/types/index';

export async function listProductsAction(): Promise<Product[]> {
  return CatalogService.getAllProducts();
}

export async function getProductAction(id: string): Promise<Product | null> {
  return CatalogService.getProductById(id) ?? null;
}

export async function createProductAction(
  productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'reservedQuantity'>,
): Promise<Product> {
  const product = CatalogService.createProduct(productData);
  revalidatePath('/admin/products');
  revalidatePath('/');
  return product;
}

export async function updateProductAction(id: string, updates: Partial<Product>): Promise<Product> {
  const product = CatalogService.updateProduct(id, updates);
  revalidatePath('/admin/products');
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

export async function deleteCategoryAction(id: string): Promise<boolean> {
  const ok = CatalogService.deleteCategory(id);
  revalidatePath('/admin/categories');
  revalidatePath('/');
  return ok;
}
