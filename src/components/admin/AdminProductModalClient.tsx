'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminProductModal } from '@/components/admin/AdminProductModal';
import type { Product, Category, TaxCategory } from '@/types/index';

export function AdminProductModalClient({
  productPromise,
  categoriesPromise,
  taxesPromise,
}: {
  productPromise: Promise<Product | null>;
  categoriesPromise: Promise<Category[]>;
  taxesPromise: Promise<TaxCategory[]>;
}) {
  const router = useRouter();
  const product = use(productPromise);
  const categories = use(categoriesPromise);
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
      taxCategories={taxes}
      onSuccess={() => {
        setOpen(false);
        router.push('/admin/products');
        router.refresh();
      }}
    />
  );
}
