import type { PublicProduct } from '@/types/index';
import { availableOf } from '@/lib/cart-quantity';
import { has } from '@/lib/values';

/** Open Graph and Twitter fields for a page, so a shared link to it says what the page says and not what the front page says. */
export function pageSocial(page: { title: string; description: string; url: string; siteName: string; image?: string | null }) {
  const images = has(page.image) ? [page.image] : [];
  return {
    openGraph: { type: 'website' as const, title: page.title, description: page.description, url: page.url, siteName: page.siteName, locale: 'en_KE', ...(images.length > 0 ? { images } : {}) },
    twitter: { card: images.length > 0 ? ('summary_large_image' as const) : ('summary' as const), title: page.title, description: page.description, ...(images.length > 0 ? { images } : {}) },
  };
}

export interface SocialTag {
  property: string;
  content: string;
}

/**
 * The extra Open Graph tags a shared product link needs so Facebook, WhatsApp, Instagram, TikTok and Pinterest can
 * show price and stock with the picture. Only what the product really has is included.
 */
export function productSocialTags(product: PublicProduct, currencyCode: string | null): SocialTag[] {
  const tags: SocialTag[] = [{ property: 'og:type', content: 'product' }];
  if (product.price !== undefined && currencyCode !== null) {
    tags.push({ property: 'product:price:amount', content: product.price.toFixed(2) }, { property: 'product:price:currency', content: currencyCode });
  }
  tags.push({ property: 'product:availability', content: availableOf(product) > 0 ? 'in stock' : 'out of stock' }, { property: 'product:condition', content: 'new' });
  if (has(product.brand)) tags.push({ property: 'product:brand', content: product.brand });
  if (has(product.category)) tags.push({ property: 'product:category', content: product.category });
  if (has(product.sku)) tags.push({ property: 'product:retailer_item_id', content: product.sku });
  return tags;
}
