'use client';

import React, { Suspense, useState } from 'react';
import { Product } from '@/types/index';
import { ProductList } from './ProductList';
import { SkeletonGrid } from '@/components/ui/Skeletons';

interface StorefrontViewProps {
  productsPromise: Promise<Product[]>;
  onSelectProduct: (product: Product) => void;
  onAddToCart: (product: Product) => void;
  onQuickBuy: (product: Product) => void;
  onRefresh: () => void;
  searchQuery?: string;
  selectedCategory?: string;
}

export function StorefrontView({
  productsPromise,
  onSelectProduct,
  onAddToCart,
  onQuickBuy,
  onRefresh,
  searchQuery = '',
  selectedCategory = 'All'
}: StorefrontViewProps) {
  return (
    <div className="space-y-4 pb-16">
      {/* Product Catalog Stream */}
      <Suspense fallback={<SkeletonGrid count={8} />}>
        <ProductList
          productsPromise={productsPromise}
          selectedCategory={selectedCategory}
          searchQuery={searchQuery}
          onSelectProduct={onSelectProduct}
          onAddToCart={onAddToCart}
          onQuickBuy={onQuickBuy}
        />
      </Suspense>
    </div>
  );
}
