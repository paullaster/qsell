import { auth } from '@/auth';
import { listCurrenciesAction } from '@/server/domains/currencies/actions';
import { listEnabledCheckoutProvidersAction } from '@/server/domains/payments/actions';
import { StorefrontCatalog } from '@/server/domains/catalog/storefront-service';
import { resolveBaseCurrency } from '@/lib/cartMoney';
import type { CurrencyConfig } from '@/types/index';
import type { StorefrontCategory } from '@/lib/storefront-search';

/** What every shop page needs around its own content. Each read stands alone, so a failure in one never blanks the page. */

/** Display name for the header: the account name, or its email when no name is set; null for a guest. */
export async function signedInName(): Promise<string | null> {
  try {
    const user = (await auth())?.user;
    if (!user) return null;
    return user.name.trim() === '' ? user.email : user.name;
  } catch {
    // An unreadable session cookie (e.g. after a secret rotation) is simply "signed out".
    return null;
  }
}

/** The currency prices are shown in, or null when none is set up (amounts then show as plain numbers). */
export async function shopCurrency(): Promise<CurrencyConfig | null> {
  try {
    return resolveBaseCurrency(await listCurrenciesAction());
  } catch {
    return null;
  }
}

/** The names of the ways to pay that are switched on. */
export async function paymentMethodLabels(): Promise<string[]> {
  try {
    return (await listEnabledCheckoutProvidersAction()).map((provider) => provider.label);
  } catch {
    return [];
  }
}

export async function shopCategories(): Promise<StorefrontCategory[]> {
  try {
    return await StorefrontCatalog.categories();
  } catch {
    return [];
  }
}
