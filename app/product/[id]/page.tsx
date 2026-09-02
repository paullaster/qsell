import { getProductAction } from '@/server/domains/catalog/actions';
import { ProductPageClient } from '@/components/store/ProductPageClient';

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const productPromise = getProductAction(id);
  return <ProductPageClient productPromise={productPromise} />;
}
