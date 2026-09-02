'use client';

import { useRouter } from 'next/navigation';
import { AdminProducts } from '@/components/admin/AdminProducts';
import type { Product, Category } from '@/types/index';

export function AdminProductsClient({
  productsPromise,
  categoriesPromise,
}: {
  productsPromise: Promise<Product[]>;
  categoriesPromise: Promise<Category[]>;
}) {
  const router = useRouter();
  return (
    <AdminProducts
      productsPromise={productsPromise}
      categoriesPromise={categoriesPromise}
      onOpenCreateProduct={() => router.push('/admin/products/new')}
      onEditProduct={(product) => router.push(`/admin/products/${product.id}`)}
      onRefresh={() => router.refresh()}
    />
  );
}
