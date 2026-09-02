'use client';

import { useRouter } from 'next/navigation';
import { AdminCategories } from '@/components/admin/AdminCategories';
import type { Category, Product } from '@/types/index';

export function AdminCategoriesClient({
  categoriesPromise,
  productsPromise,
}: {
  categoriesPromise: Promise<Category[]>;
  productsPromise: Promise<Product[]>;
}) {
  const router = useRouter();
  return (
    <AdminCategories
      categoriesPromise={categoriesPromise}
      productsPromise={productsPromise}
      onRefresh={() => router.refresh()}
    />
  );
}
