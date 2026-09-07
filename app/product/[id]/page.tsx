import { notFound } from 'next/navigation';
import { getProductAction } from '@/server/domains/catalog/actions';
import { ProductPageClient } from '@/components/store/ProductPageClient';

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProductAction(id);
  if (!product || !product.isActive || product.isSellable === false) {
    notFound();
  }
  return <ProductPageClient productPromise={Promise.resolve(product)} />;
}
