import { listSellableProductsAction } from '@/server/domains/catalog/actions';
import { listOrdersAction } from '@/server/domains/orders/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { StorefrontPageClientBoundary } from '@/components/store/StorefrontPageClient';

export default async function HomePage() {
  const productsPromise = listSellableProductsAction();
  const ordersPromise = listOrdersAction();
  const companyPromise = getCompanySettingsAction();

  return (
    <StorefrontPageClientBoundary
      productsPromise={productsPromise}
      ordersPromise={ordersPromise}
      companyPromise={companyPromise}
    />
  );
}
