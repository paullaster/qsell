'use client';

import { useRouter } from 'next/navigation';
import { AdminProducts } from '@/components/admin/AdminProducts';
import { useAdminNavAccess } from '@/components/admin/nav/AdminNavAccessProvider';
import type { Product, Category } from '@/types/index';

export function AdminProductsClient({
  productsPromise,
  categoriesPromise,
  trashCount,
}: {
  productsPromise: Promise<Product[]>;
  categoriesPromise: Promise<Category[]>;
  trashCount: number;
}) {
  const router = useRouter();
  const access = useAdminNavAccess();
  const canDelete =
    access !== null && (access.superAdmin || access.permissions.includes('products:delete'));
  const canPurge =
    access !== null &&
    (access.superAdmin || access.permissions.includes('products:delete_permanently'));
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
