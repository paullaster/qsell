import { auth } from '@/auth';
import { listSellableProductsAction } from '@/server/domains/catalog/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { StorefrontPageClientBoundary } from '@/components/store/StorefrontPageClient';

/** Display name for the navbar: the account name, or its email when no name is set. */
async function signedInName(): Promise<string | null> {
  try {
    const user = (await auth())?.user;
    if (!user) return null;
    return user.name.trim() === '' ? user.email : user.name;
  } catch {
    // An unreadable session cookie (e.g. after a secret rotation) is simply "signed out".
    return null;
  }
}

export default function HomePage() {
  const productsPromise = listSellableProductsAction();
  const companyPromise = getCompanySettingsAction();
  const sessionNamePromise = signedInName();

  return (
    <StorefrontPageClientBoundary
      productsPromise={productsPromise}
      companyPromise={companyPromise}
      sessionNamePromise={sessionNamePromise}
    />
  );
}
