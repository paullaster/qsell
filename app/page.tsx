import { listProductsAction } from '@/server/domains/catalog/actions';
import { listOrdersAction } from '@/server/domains/orders/actions';
import { StorefrontPageClientBoundary } from '@/components/store/StorefrontPageClient';

export default async function HomePage() {
  const productsPromise = listProductsAction();
  const ordersPromise = listOrdersAction();

  return (
    <StorefrontPageClientBoundary
      productsPromise={productsPromise}
      ordersPromise={ordersPromise}
    />
  );
}
