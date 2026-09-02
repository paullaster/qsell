'use client';

import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Product } from '@/types/index';
import { ProductDetailModal } from '@/components/store/ProductDetailModal';

export function ProductPageClient({
  productPromise,
  asModal = false,
}: {
  productPromise: Promise<Product | null>;
  asModal?: boolean;
}) {
  const product = use(productPromise);
  const router = useRouter();

  if (!product) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="space-y-3 text-center">
          <p className="text-zinc-400">Product not found</p>
          <Link href="/" className="text-sm text-indigo-400 hover:underline">
            Back to store
          </Link>
        </div>
      </div>
    );
  }

  if (asModal) {
    return (
      <ProductDetailModal
        product={product}
        onClose={() => router.back()}
        onAddToCart={() => router.back()}
        onQuickBuy={() => router.back()}
      />
    );
  }

  return (
    <div className="min-h-screen bg-black">
      <div className="mx-auto max-w-7xl px-4 py-6">
        <Link href="/" className="text-sm text-zinc-500 hover:text-indigo-400">
          ← Back to store
        </Link>
      </div>
      <ProductDetailModal
        product={product}
        onClose={() => router.push('/')}
        onAddToCart={() => {}}
        onQuickBuy={() => router.push('/')}
      />
    </div>
  );
}
