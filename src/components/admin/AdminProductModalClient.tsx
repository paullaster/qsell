'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminProductModal } from '@/components/admin/AdminProductModal';
import { publishProductUpdated } from '@/components/admin/product-updated';
import type { Product, Category, ItemType, TaxCategory } from '@/types/index';

export function AdminProductModalClient({
  productPromise,
  duplicateFromPromise,
  categoriesPromise,
  itemTypesPromise,
  taxesPromise,
  returnOnSave = false,
}: {
  productPromise: Promise<Product | null>;
  duplicateFromPromise?: Promise<Product | null>;
  categoriesPromise: Promise<Category[]>;
  itemTypesPromise: Promise<ItemType[]>;
  taxesPromise: Promise<TaxCategory[]>;
  /** Opened from a line on another screen: after saving, say which product changed and go back there (not to the list). */
  returnOnSave?: boolean;
}) {
  const router = useRouter();
  const product = use(productPromise);
  const duplicateFrom = duplicateFromPromise ? use(duplicateFromPromise) : null;
  const categories = use(categoriesPromise);
  const itemTypes = use(itemTypesPromise);
  const taxes = use(taxesPromise);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setOpen(true);
  }, [product, duplicateFrom]);

  return (
    <AdminProductModal
      isOpen={open}
      onClose={() => {
        setOpen(false);
        router.back();
      }}
      productToEdit={product}
      duplicateFrom={duplicateFrom}
      categories={categories}
      itemTypes={itemTypes}
      taxCategories={taxes}
      onSuccess={() => {
        if (returnOnSave && product !== null) {
          // The modal then closes itself with onClose, which goes back to the screen the person came from.
          publishProductUpdated(product.id);
          return;
        }
        setOpen(false);
        router.push('/admin/products');
        router.refresh();
      }}
    />
  );
}
