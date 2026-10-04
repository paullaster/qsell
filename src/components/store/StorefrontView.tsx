'use client';

import React, { Suspense } from 'react';
import { type PublicProduct } from '@/types/index';
import { ProductList } from './ProductList';
import { SkeletonGrid } from '@/components/ui/Skeletons';

interface StorefrontViewProps {
  productsPromise: Promise<PublicProduct[]>;
  onSelectProduct: (product: PublicProduct) => void;
  onAddToCart: (product: PublicProduct) => void;
  onQuickBuy: (product: PublicProduct) => void;
  onRefresh: () => void;
  searchQuery?: string;
  selectedCategory?: string;
  onSelectCategory?: (category: string) => void;
}

export function StorefrontView({
  productsPromise,
  onSelectProduct,
  onAddToCart,
  onQuickBuy,
  searchQuery = '',
  selectedCategory = 'All',
  onSelectCategory,
}: StorefrontViewProps) {
  return (
    <div className="space-y-4 pb-16">
      <Suspense fallback={<SkeletonGrid count={8} />}>
        <ProductList
          productsPromise={productsPromise}
          selectedCategory={selectedCategory}
          onSelectCategory={onSelectCategory}
          searchQuery={searchQuery}
          onSelectProduct={onSelectProduct}
          onAddToCart={onAddToCart}
          onQuickBuy={onQuickBuy}
        />
      </Suspense>
    </div>
  );
}
