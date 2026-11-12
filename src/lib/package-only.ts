/**
 * Rules for a product that is sold only inside packages (docs/architecture/configurable-packages.md section 4).
 * Pure: the callers pass what they know and get a plain-language problem or nothing.
 */

export interface PackageOnlyFacts {
  soldOnlyInPackages: boolean;
  isCheckoutPackaging: boolean;
  /** Whether the product is sold to customers at all (it needs a selling price to be priced inside a package). */
  isSellable: boolean;
}

/** Why a product cannot be saved as package-only, or null. */
export function packageOnlyProblem(facts: PackageOnlyFacts): string | null {
  if (!facts.soldOnlyInPackages) return null;
  if (facts.isCheckoutPackaging) return 'A product cannot be both checkout packaging and sold only inside packages. Choose one.';
  if (!facts.isSellable) return 'A product sold inside packages must use a sellable item type and have a selling price, so a package can price it.';
  return null;
}

/** What a person is told when a package-only product is asked for on its own (basket, order, quote, invoice). */
export function packageOnlyRefusal(productName: string): string {
  return `${productName} is sold only as part of a package and cannot be ordered on its own.`;
}

/** The first product in these that is sold only inside packages, or undefined. */
export function firstPackageOnly<T extends { soldOnlyInPackages?: boolean }>(products: readonly (T | undefined)[]): T | undefined {
  return products.find((product) => product?.soldOnlyInPackages === true);
}
