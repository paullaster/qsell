import { getPublicProductAction } from '@/server/domains/catalog/actions';
import { ProductPageClient } from '@/components/store/ProductPageClient';

export default async function InterceptedProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const productPromise = getPublicProductAction(id);
  return <ProductPageClient productPromise={productPromise} asModal />;
}
