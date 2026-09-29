import { listSellableProductsAction } from '@/server/domains/catalog/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { StorefrontPageClientBoundary } from '@/components/store/StorefrontPageClient';

export default function HomePage() {
  const productsPromise = listSellableProductsAction();
  const companyPromise = getCompanySettingsAction();

  return (
    <StorefrontPageClientBoundary
      productsPromise={productsPromise}
      companyPromise={companyPromise}
    />
  );
}
