import { describe, expect, it } from 'vitest';

interface OfferShape {
  url: string;
  keywords: string;
  offers: { itemCondition: string; hasMerchantReturnPolicy: { merchantReturnLink: string } };
  '@type': string;
  featureList: string[];
}

import type { PublicProduct } from '@/types/index';
import { DEFAULT_COMPANY_SUPPORT_CONFIG } from '@/config/company-ui';
import { productJsonLd } from '@/lib/product-seo';
import { aboutView } from './about';
import { helpView } from './help';
import { countryCode, faqJsonLd, organizationJsonLd, returnPolicyPage, websiteJsonLd, type JsonLdCompany } from './jsonld';
import { platformView, softwareJsonLd } from './platform';
import { shareImageUrl } from './share';
import { productSocialTags } from './social';
import { categoryTitle, clip, homeDescription, homeKeywords, homeTitle, priceText, productDescription, productKeywords, productTitle, uniqueWords } from './text';

const company: JsonLdCompany = {
  legalName: "Noel's Deliveries Limited",
  tradingName: "Noel's Deliveries",
  tagline: 'Fresh fish delivered fast',
  city: 'Nairobi',
  countyOrState: 'Nairobi County',
  country: 'Kenya',
  locationLabel: 'Westlands',
  email: 'hello@noels.example',
  phone: '+254 712 345 678',
  tel: null,
  website: 'https://noelsdeliveries.com',
  streetAddress: 'Ring Road 1',
  postalCode: '00100',
  logoUrl: '/api/company/logo/logo-1.png',
};

const product = {
  id: 'p1', sku: 'SAR-1', name: 'Deepfried Sardines', slug: 'deepfried-sardines', description: '', category: 'Fish', brand: 'Noels',
  price: 350, stockQuantity: 10, reservedQuantity: 2, imageUrl: 'https://media.example/a.jpg', tags: ['sardines', 'fried fish'], rating: 0, reviewCount: 0,
} as unknown as PublicProduct;

describe('titles and descriptions come from the company', () => {
  it('leads the home title with the trading name and the town, within 70 characters', () => {
    expect(homeTitle(company)).toBe("Noel's Deliveries — Fresh fish delivered fast | Nairobi");
    expect(homeTitle({ ...company, tagline: null })).toBe("Noel's Deliveries — Online shop in Nairobi, Kenya");
    expect(homeTitle({ ...company, tradingName: 'A very long trading name '.repeat(5) }).length).toBeLessThanOrEqual(70);
  });

  it('names the categories, the place and the first guarantee, up to 160 characters', () => {
    const text = homeDescription(company, { categories: ['Fish', 'Fish', 'Chicken'], guarantee: 'Refund if it is not fresh.' });
    expect(text).toContain("Noel's Deliveries — Fresh fish delivered fast.");
    expect(text).toContain('Shop Fish, Chicken');
    expect(text).toContain('Nairobi, Kenya');
    expect(text).toContain('Refund if it is not fresh.');
    expect(text.length).toBeLessThanOrEqual(160);
  });

  it('puts the business name and town in the keywords, once each', () => {
    const words = homeKeywords(company, ['Fish']);
    expect(words).toContain("Noel's Deliveries Nairobi");
    expect(words).toContain('Fish Nairobi');
    expect(new Set(words.map((w) => w.toLowerCase())).size).toBe(words.length);
  });

  it('writes a product title with price and town, and a description with stock and seller', () => {
    const context = { company, currencyCode: 'KES' };
    expect(productTitle(product, context)).toBe('Deepfried Sardines – KES 350 in Nairobi');
    const text = productDescription(product, context);
    expect(text).toContain('Buy Deepfried Sardines by Noels (Fish) online in Nairobi, Kenya.');
    expect(text).toContain('KES 350.');
    expect(text).toContain('In stock.');
    expect(productDescription({ ...product, stockQuantity: 0 }, context)).toContain('out of stock');
    expect(productKeywords(product, company)).toEqual(expect.arrayContaining(['Deepfried Sardines Nairobi', 'buy Deepfried Sardines online', 'sardines']));
  });

  it('uses the written description when there is a real one', () => {
    const long = { ...product, description: 'Golden crispy sardines, fried to order in sunflower oil and packed hot for the road.' };
    expect(productDescription(long, { company, currencyCode: 'KES' })).toMatch(/^Golden crispy sardines/);
  });

  it('shows a category with the town', () => {
    expect(categoryTitle(company, 'Fish')).toBe('Fish in Nairobi, Kenya');
  });

  it('formats prices and keeps unique words', () => {
    expect(priceText(1250, 'KES')).toBe('KES 1,250');
    expect(priceText(99.5, null)).toBe('99.50');
    expect(uniqueWords(['a', 'A', ' b ', ''], 5)).toEqual(['a', 'b']);
    expect(clip('word '.repeat(100), 30).endsWith('…')).toBe(true);
  });
});

describe('a company that has not entered a town yet', () => {
  const bare = { ...company, city: '', country: '', countyOrState: '', tagline: null, locationLabel: null };

  it('gets clean text with no dangling words', () => {
    expect(homeTitle(bare)).toBe("Noel's Deliveries — Online shop");
    expect(homeDescription(bare, { categories: ['Fish'] })).toBe("Noel's Deliveries. Shop Fish and more online. Easy ordering and secure payment.");
    expect(categoryTitle(bare, 'Fish')).toBe('Fish');
    expect(productTitle(product, { company: bare, currencyCode: 'KES' })).toBe('Deepfried Sardines – KES 350');
    expect(productKeywords(product, bare).every((word) => !word.endsWith(" ") && word !== '')).toBe(true);
    expect(homeKeywords(bare).every((word) => !word.endsWith(" "))).toBe(true);
    expect(aboutView(bare, [], []).paragraphs[0]).toBe("Noel's Deliveries is an online shop.");
  });
});

describe('structured data says only what the company wrote', () => {
  const support = { channels: [{ id: 'c1', kind: 'whatsapp' as const, label: 'WhatsApp', value: '+254 700 111 222', detail: '', url: '' }, { id: 'c2', kind: 'email' as const, label: '', value: 'sales@noels.example', detail: '', url: '' }] };

  it('describes the business as a store with address, contacts and links', () => {
    const data = organizationJsonLd(company, support, 'https://shop.noels.example/', '/api/company/logo/logo-1.png');
    expect(data['@type']).toBe('Store');
    expect(data['@id']).toBe('https://shop.noels.example/#organization');
    expect(data.name).toBe("Noel's Deliveries");
    expect(data.legalName).toBe("Noel's Deliveries Limited");
    expect(data.slogan).toBe('Fresh fish delivered fast');
    expect(data.telephone).toBe('+254712345678');
    expect(data.address).toMatchObject({ addressLocality: 'Nairobi', addressRegion: 'Nairobi County', addressCountry: 'KE', streetAddress: 'Ring Road 1' });
    expect(data.sameAs).toEqual(['https://noelsdeliveries.com', 'https://wa.me/254700111222']);
    expect(JSON.stringify(data.contactPoint)).toContain('sales@noels.example');
    expect(JSON.stringify(data.logo)).toContain('https://shop.noels.example/api/company/logo/logo-1.png');
  });

  it('leaves out what is empty and never prints the tax pin or bank details', () => {
    const bare = organizationJsonLd({ ...company, tagline: null, website: null, tel: null, logoUrl: null, phone: '', email: '' }, { channels: [] }, 'https://x.example', null);
    expect(bare).not.toHaveProperty('slogan');
    expect(bare).not.toHaveProperty('sameAs');
    expect(bare).not.toHaveProperty('contactPoint');
    expect(bare).not.toHaveProperty('logo');
    expect(JSON.stringify(organizationJsonLd(company, support, 'https://x.example', null))).not.toMatch(/kra|pin|bank/i);
  });

  it('offers a search box and is tied to the business', () => {
    const data = websiteJsonLd(company, 'https://x.example');
    expect(data.potentialAction).toMatchObject({ '@type': 'SearchAction', target: { urlTemplate: 'https://x.example/?q={search_term_string}' } });
    expect(data.publisher).toEqual({ '@id': 'https://x.example/#organization' });
  });

  it('builds questions only from complete pairs and nothing when there are none', () => {
    expect(faqJsonLd([])).toBeNull();
    expect(faqJsonLd([{ question: 'Q?', answer: '' }])).toBeNull();
    const data = faqJsonLd([{ question: 'Do you deliver?', answer: 'Yes, in Nairobi.' }]);
    expect(JSON.stringify(data)).toContain('Do you deliver?');
  });

  it('knows country codes and finds the returns page', () => {
    expect(countryCode('Kenya')).toBe('KE');
    expect(countryCode('ke')).toBe('KE');
    const page = { id: '1', title: 'Returns and refunds', slug: 'returns', body: 'x' };
    expect(returnPolicyPage([{ id: '0', title: 'Privacy', slug: 'privacy', body: 'x' }, page])).toBe(page);
    expect(returnPolicyPage([])).toBeNull();
  });

  it('puts the return policy and keywords on a product offer', () => {
    const data = productJsonLd(product, { baseUrl: 'https://x.example', currencyCode: 'KES', storeName: 'N', returnPolicyUrl: 'https://x.example/policies/returns' }) as unknown as OfferShape;
    expect(data.url).toBe('https://x.example/product/deepfried-sardines');
    expect(data.keywords).toBe('sardines, fried fish');
    expect(data.offers.itemCondition).toBe('https://schema.org/NewCondition');
    expect(data.offers.hasMerchantReturnPolicy.merchantReturnLink).toBe('https://x.example/policies/returns');
  });
});

describe('a shared link shows the product', () => {
  it('resizes through the app so chat apps accept the picture', () => {
    expect(shareImageUrl('https://shop.example', 'https://media.example/a.jpg')).toBe('https://shop.example/_next/image?url=https%3A%2F%2Fmedia.example%2Fa.jpg&w=1200&q=75');
  });
  it('passes a picture of this same site as a path', () => {
    expect(shareImageUrl('https://shop.example', 'https://shop.example/api/media/file/a.png')).toBe('https://shop.example/_next/image?url=%2Fapi%2Fmedia%2Ffile%2Fa.png&w=1200&q=75');
    expect(shareImageUrl('https://shop.example/', '/api/media/file/a.png')).toContain('url=%2Fapi%2Fmedia%2Ffile%2Fa.png');
  });
  it('leaves vector pictures and blanks alone', () => {
    expect(shareImageUrl('https://shop.example', '/logo.svg')).toBe('https://shop.example/logo.svg');
    expect(shareImageUrl('https://shop.example', '  ')).toBeNull();
  });
  it('adds price, stock, brand and category tags', () => {
    const tags = Object.fromEntries(productSocialTags(product, 'KES').map((tag) => [tag.property, tag.content]));
    expect(tags).toMatchObject({ 'og:type': 'product', 'product:price:amount': '350.00', 'product:price:currency': 'KES', 'product:availability': 'in stock', 'product:brand': 'Noels', 'product:category': 'Fish' });
    expect(productSocialTags({ ...product, price: undefined }, 'KES').some((tag) => tag.property.startsWith('product:price'))).toBe(false);
  });
});

describe('the help and about text', () => {
  const support = { ...DEFAULT_COMPANY_SUPPORT_CONFIG, channels: [{ id: 'c1', kind: 'phone' as const, label: 'Orders', value: '+254712345678', detail: '8am-8pm', url: '' }], faqs: [{ id: 'f1', question: 'Do you deliver?', answer: 'Yes.' }, { id: 'f2', question: '', answer: 'x' }], guarantees: [{ id: 'g1', text: 'Fresh or refunded.' }] };

  it('is never empty: the profile gives contacts, and a repeated number is shown once', () => {
    const view = helpView(company, DEFAULT_COMPANY_SUPPORT_CONFIG);
    expect(view.contacts.map((c) => c.kind)).toEqual(['phone', 'email', 'address']);
    expect(view.faqs).toEqual([]);
    const withChannel = helpView(company, support);
    expect(withChannel.contacts.filter((c) => c.value.includes('712')).length).toBe(1);
    expect(withChannel.faqs).toHaveLength(1);
    expect(withChannel.guarantees).toEqual(['Fresh or refunded.']);
    expect(withChannel.description.length).toBeLessThanOrEqual(160);
  });

  it('writes the about text from the town, the tagline and the categories', () => {
    const view = aboutView(company, [{ name: 'Fish', slug: 'fish', depth: 0 }, { name: 'Tilapia', slug: 'tilapia', depth: 1 }], ['Fresh or refunded.']);
    expect(view.paragraphs[0]).toBe("Noel's Deliveries — Fresh fish delivered fast. We are based in Nairobi, Kenya, Westlands.");
    expect(view.paragraphs[1]).toContain('Shop Fish and more');
    expect(view.categories).toEqual([{ name: 'Fish', slug: 'fish' }]);
  });
});

describe('the platform page', () => {
  it('names the shop and its town and describes the software', () => {
    const view = platformView(company);
    expect(view.intro).toContain("Noel's Deliveries in Nairobi, Kenya");
    const data = softwareJsonLd(view, 'https://x.example/platform') as unknown as OfferShape;
    expect(data['@type']).toBe('SoftwareApplication');
    expect(data.featureList.length).toBeGreaterThan(20);
  });
});
