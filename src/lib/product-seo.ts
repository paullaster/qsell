import type { PublicProduct } from '@/types/index';
import { productDescriptionPlainText } from '@/lib/productDescription';
import { availableOf } from '@/lib/cart-quantity';
import { has } from '@/lib/values';
import { productHref } from '@/lib/product-link';

/** A text cut to a length for a search result or a shared link, at a word, with an ellipsis when it was cut. */
export function metaDescription(text: string, max = 160): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max * 0.6 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** The pictures of a product, the main one first, without repeats or blanks. */
export function productImages(product: Pick<PublicProduct, 'imageUrl' | 'additionalImages'>): string[] {
  return [...new Set([product.imageUrl, ...(product.additionalImages ?? [])].map((url) => url.trim()).filter((url) => has(url)))];
}

/** An address made absolute against the shop's address. Absolute addresses are kept as they are. */
export function absoluteUrl(base: string, path: string): string {
  return /^https?:\/\//i.test(path) ? path : `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** What a search engine reads to show price and stock beside the result (schema.org Product). */
export function productJsonLd(
  product: PublicProduct,
  context: { baseUrl: string; currencyCode: string | null; storeName: string; returnPolicyUrl?: string | null },
): Record<string, unknown> {
  const url = absoluteUrl(context.baseUrl, productHref(product));
  const images = productImages(product).map((image) => absoluteUrl(context.baseUrl, image));
  const description = metaDescription(productDescriptionPlainText(product.description), 500);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${url}#product`,
    name: product.name,
    url,
    sku: product.sku,
    mpn: product.sku,
    ...(product.tags.length > 0 ? { keywords: product.tags.join(', ') } : {}),
    ...(images.length > 0 ? { image: images } : {}),
    ...(description === '' ? {} : { description }),
    ...(has(product.brand) ? { brand: { '@type': 'Brand', name: product.brand } } : {}),
    ...(has(product.category) ? { category: product.category } : {}),
    ...(product.price !== undefined && context.currencyCode !== null
      ? {
          offers: {
            '@type': 'Offer',
            url,
            price: product.price.toFixed(2),
            priceCurrency: context.currencyCode,
            availability: availableOf(product) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
            itemCondition: 'https://schema.org/NewCondition',
            ...(has(context.returnPolicyUrl) ? { hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy', merchantReturnLink: context.returnPolicyUrl } } : {}),
            seller: { '@type': 'Organization', name: context.storeName },
          },
        }
      : {}),
    // Stars are claimed only when there are reviews behind them.
    ...(product.reviewCount > 0 ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: product.rating.toFixed(1), reviewCount: product.reviewCount } } : {}),
  };
}

export function breadcrumbJsonLd(trail: { name: string; url: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: item.url })),
  };
}

/** Structured data as text for a script tag. `<` is escaped so no stored text can close the tag early. */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data)
    .replaceAll('<', '\\u003c')
    .replaceAll(String.fromCharCode(0x2028), '\\u2028')
    .replaceAll(String.fromCharCode(0x2029), '\\u2029');
}
