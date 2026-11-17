/**
 * How a package is ordered on the web shop: straight into the cart, by asking for a quote first (corporate and event packages whose
 * price and terms are agreed with the company), or either, the shopper choosing.
 */
export const PACKAGE_ORDER_MODES = ['cart', 'quote', 'either'] as const;
export type PackageOrderMode = (typeof PACKAGE_ORDER_MODES)[number];

/** What the setting means for a value that may be missing or from an older save: no setting is the cart, as before. */
export const orderModeOf = (raw: unknown): PackageOrderMode => PACKAGE_ORDER_MODES.find((m) => m === raw) ?? 'cart';

/** The shopper may put the package in the cart (and so order it at checkout or start a group order for it). */
export const allowsCart = (mode: PackageOrderMode): boolean => mode !== 'quote';

/** The shopper may ask for a quote. */
export const allowsQuote = (mode: PackageOrderMode): boolean => mode !== 'cart';

export const quoteOnlyRefusal = (name: string): string => `${name} is ordered by quote request. Please ask for a quote and we will send you the price.`;
