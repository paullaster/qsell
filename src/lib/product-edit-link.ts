/**
 * The address of a product's edit window when it is opened from a line on another screen. `quick` tells the window to close back
 * onto that screen after saving (and to say which product changed) instead of going to the product list.
 */
export function productEditHref(productId: string): string {
  return `/admin/products/${encodeURIComponent(productId)}?quick=1`;
}

/** Whether the address asked for the shortcut behaviour. Only the exact value counts. */
export function isQuickEdit(value: string | string[] | undefined): boolean {
  return value === '1';
}
