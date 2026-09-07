'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminProductModal } from '@/components/admin/AdminProductModal';
import type { Product, Category, ItemType, TaxCategory } from '@/types/index';

export function AdminProductModalClient({
  productPromise,
  categoriesPromise,
  itemTypesPromise,
  taxesPromise,
}: {
  productPromise: Promise<Product | null>;
  categoriesPromise: Promise<Category[]>;
  itemTypesPromise: Promise<ItemType[]>;
  taxesPromise: Promise<TaxCategory[]>;
}) {
  const router = useRouter();
  const product = use(productPromise);
  const categories = use(categoriesPromise);
  const itemTypes = use(itemTypesPromise);
  const taxes = use(taxesPromise);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setOpen(true);
  }, [product]);

  return (
    <AdminProductModal
      isOpen={open}
      onClose={() => {
        setOpen(false);
        router.back();
      }}
      productToEdit={product}
      categories={categories}
      itemTypes={itemTypes}
      taxCategories={taxes}
      onSuccess={() => {
        setOpen(false);
        router.push('/admin/products');
        router.refresh();
      }}
    />
  );
}
