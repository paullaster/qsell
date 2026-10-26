/** The address of a product's page. It uses the product's readable name (its slug), so a shared link says what it is. */
export const productHref = (product: { id: string; slug?: string }): string => `/product/${product.slug !== undefined && product.slug !== '' ? product.slug : product.id}`;
