import { describe, expect, it } from 'vitest';

interface OfferShape {
  url: string;
  keywords: string;
  offers: { itemCondition: string; hasMerchantReturnPolicy: { merchantReturnLink: string } };
  '@type': string;
  featureList: string[];
}

import type { PublicProduct } from '@/types/index';
import { absoluteUrl, breadcrumbJsonLd, jsonLdText, metaDescription, productImages, productJsonLd } from './product-seo';

const product = (over: Partial<PublicProduct> = {}): PublicProduct =>
  ({ id: 'p1', sku: 'RICE-5', name: 'Rice 5kg', description: 'Long grain rice', category: 'Grains', brand: 'Pishori', price: 650, stockQuantity: 10, reservedQuantity: 0, lowStockThreshold: 2, imageUrl: '/a.jpg', additionalImages: ['/b.jpg', '/a.jpg', ' '], rating: 4.5, reviewCount: 0, tags: [], ...over }) as PublicProduct;
const ctx = { baseUrl: 'https://shop.example/', currencyCode: 'KES', storeName: 'Shop' };

describe('metaDescription', () => {
  it('keeps short text and cuts long text at a word', () => {
    expect(metaDescription('  A   short\n text ')).toBe('A short text');
    const cut = metaDescription('word '.repeat(100), 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/wor…$/);
  });
});

describe('productImages / absoluteUrl', () => {
  it('lists each picture once, main first, without blanks', () => {
    expect(productImages(product())).toEqual(['/a.jpg', '/b.jpg']);
    expect(productImages(product({ imageUrl: '', additionalImages: undefined }))).toEqual([]);
  });
  it('makes addresses absolute without doubling slashes', () => {
    expect(absoluteUrl('https://x.test/', '/product/1')).toBe('https://x.test/product/1');
    expect(absoluteUrl('https://x.test', 'https://cdn.test/a.jpg')).toBe('https://cdn.test/a.jpg');
  });
});

describe('productJsonLd', () => {
  it('adds the address, tags and the returns page to the offer', () => {
    const data = productJsonLd(product({ slug: 'rice', tags: ['rice', 'grain'] }), { ...ctx, returnPolicyUrl: 'https://shop.example/policies/returns' }) as unknown as OfferShape;
    expect(data.keywords).toBe('rice, grain');
    expect(data.offers.itemCondition).toBe('https://schema.org/NewCondition');
    expect(data.offers.hasMerchantReturnPolicy.merchantReturnLink).toBe('https://shop.example/policies/returns');
  });

  it('describes price, stock, brand and pictures', () => {
    const data = productJsonLd(product(), ctx);
    expect(data).toMatchObject({
      '@type': 'Product',
      name: 'Rice 5kg',
      sku: 'RICE-5',
      image: ['https://shop.example/a.jpg', 'https://shop.example/b.jpg'],
      brand: { name: 'Pishori' },
      offers: { price: '650.00', priceCurrency: 'KES', availability: 'https://schema.org/InStock', url: 'https://shop.example/product/p1' },
    });
  });
  it('says out of stock when nothing is available', () => {
    const data = productJsonLd(product({ stockQuantity: 3, reservedQuantity: 3 }), ctx) as { offers: { availability: string } };
    expect(data.offers.availability).toBe('https://schema.org/OutOfStock');
  });
  it('claims a rating only when there are reviews', () => {
    expect(productJsonLd(product(), ctx)).not.toHaveProperty('aggregateRating');
    expect(productJsonLd(product({ reviewCount: 12 }), ctx)).toMatchObject({ aggregateRating: { ratingValue: '4.5', reviewCount: 12 } });
  });
  it('leaves out an offer it cannot price', () => {
    expect(productJsonLd(product({ price: undefined }), ctx)).not.toHaveProperty('offers');
    expect(productJsonLd(product(), { ...ctx, currencyCode: null })).not.toHaveProperty('offers');
  });
});

describe('breadcrumbJsonLd / jsonLdText', () => {
  it('numbers the trail from 1', () => {
    expect(breadcrumbJsonLd([{ name: 'Home', url: 'u1' }, { name: 'Rice', url: 'u2' }])).toMatchObject({ itemListElement: [{ position: 1 }, { position: 2, name: 'Rice' }] });
  });
  it('cannot be made to close the script tag', () => {
    const text = jsonLdText({ name: '</script><script>alert(1)</script>' });
    expect(text).not.toContain('<');
    expect(JSON.parse(text)).toEqual({ name: '</script><script>alert(1)</script>' });
  });
});
