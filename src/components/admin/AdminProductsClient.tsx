'use client';

import { useRouter } from 'next/navigation';
import { AdminProducts } from '@/components/admin/AdminProducts';
import type { Product, Category } from '@/types/index';

export function AdminProductsClient({
  productsPromise,
  categoriesPromise,
  canDelete,
  canPurge,
  trashCount,
}: {
  productsPromise: Promise<Product[]>;
  categoriesPromise: Promise<Category[]>;
  canDelete: boolean;
  canPurge: boolean;
  trashCount: number;
}) {
  const router = useRouter();
  return (
    <AdminProducts
      productsPromise={productsPromise}
      categoriesPromise={categoriesPromise}
      canDelete={canDelete}
      canPurge={canPurge}
      trashCount={trashCount}
      onOpenCreateProduct={() => router.push('/admin/products/new')}
      onEditProduct={(product) => router.push(`/admin/products/${product.id}`)}
      onDuplicateProduct={(product) =>
        router.push(`/admin/products/new?duplicateFrom=${encodeURIComponent(product.id)}`)
      }
      onRefresh={() => router.refresh()}
    />
  );
}
