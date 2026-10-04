import { notFound } from 'next/navigation';
import { getPublicProductAction } from '@/server/domains/catalog/actions';
import { ProductPageClient } from '@/components/store/ProductPageClient';

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getPublicProductAction(id);
  if (!product) notFound();
  return <ProductPageClient productPromise={Promise.resolve(product)} />;
}
