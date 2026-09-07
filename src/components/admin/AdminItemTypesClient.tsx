'use client';

import { useRouter } from 'next/navigation';
import { AdminItemTypes } from '@/components/admin/AdminItemTypes';
import type { ItemType, Product } from '@/types/index';

export function AdminItemTypesClient({
  itemTypesPromise,
  productsPromise,
}: {
  itemTypesPromise: Promise<ItemType[]>;
  productsPromise: Promise<Product[]>;
}) {
  const router = useRouter();
  return (
    <AdminItemTypes
      itemTypesPromise={itemTypesPromise}
      productsPromise={productsPromise}
      onRefresh={() => router.refresh()}
    />
  );
}
