'use client';

import { useRouter } from 'next/navigation';
import { AdminInventory } from '@/components/admin/AdminInventory';
import type { Product, InventoryLedgerEntry } from '@/types/index';

export function AdminInventoryClient({
  productsPromise,
  ledgerPromise,
}: {
  productsPromise: Promise<Product[]>;
  ledgerPromise: Promise<InventoryLedgerEntry[]>;
}) {
  const router = useRouter();
  return (
    <AdminInventory
      productsPromise={productsPromise}
      ledgerPromise={ledgerPromise}
      onRefresh={() => router.refresh()}
    />
  );
}
