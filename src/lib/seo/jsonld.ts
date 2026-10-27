import { supportChannelHref, type CompanySupportConfig, type PolicyPage } from '@/config/company-ui';
import { has } from '@/lib/values';
import { placeOf, type SeoCompany } from './text';

/** Structured data about the business, built from the company's own setup. Only what the company has written is claimed. */

export interface JsonLdCompany extends SeoCompany {
  email: string;
  phone: string;
  tel: string | null;
  website: string | null;
  streetAddress: string;
  postalCode: string;
  logoUrl: string | null;
}

const COUNTRY_CODES: Record<string, string> = { kenya: 'KE', uganda: 'UG', tanzania: 'TZ', rwanda: 'RW', ethiopia: 'ET', nigeria: 'NG', ghana: 'GH', 'south africa': 'ZA' };

export function countryCode(country: string): string {
  const name = country.trim();
  return COUNTRY_CODES[name.toLowerCase()] ?? (/^[A-Za-z]{2}$/.test(name) ? name.toUpperCase() : name);
}

const absolute = (base: string, path: string): string =>
  /^https?:\/\//i.test(path) ? path : `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

/** Telephone as people dial it: digits with a leading plus when one was written. */
function telephone(value: string): string | null {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  return `${value.trim().startsWith('+') ? '+' : ''}${digits}`;
}

export function organizationJsonLd(
  company: JsonLdCompany,
  support: Pick<CompanySupportConfig, 'channels'>,
  base: string,
  logo: string | null,
): Record<string, unknown> {
  const phones = [company.phone, company.tel ?? '', ...support.channels.filter((c) => c.kind === 'phone' || c.kind === 'whatsapp').map((c) => c.value)]
    .map(telephone)
    .filter((value): value is string => value !== null);
  const emails = [company.email, ...support.channels.filter((c) => c.kind === 'email').map((c) => c.value)].filter((value) => /^[^\s@]+@[^\s@]+$/.test(value));
  const sameAs = [
    ...(has(company.website) ? [company.website] : []),
    ...support.channels
      .filter((c) => c.kind === 'website' || c.kind === 'telegram' || c.kind === 'whatsapp' || c.kind === 'other')
      .map((c) => supportChannelHref(c))
      .filter((href): href is string => href?.startsWith('http') === true),
  ];
  const contactPoints = [
    ...[...new Set(phones)].map((value) => ({ '@type': 'ContactPoint', contactType: 'customer service', telephone: value, areaServed: countryCode(company.country), availableLanguage: ['English', 'Swahili'] })),
    ...[...new Set(emails)].map((value) => ({ '@type': 'ContactPoint', contactType: 'customer service', email: value, areaServed: countryCode(company.country), availableLanguage: ['English', 'Swahili'] })),
  ];
  return {
    '@context': 'https://schema.org',
    '@type': 'Store',
    '@id': `${base.replace(/\/+$/, '')}/#organization`,
    name: company.tradingName,
    ...(company.legalName === company.tradingName ? {} : { legalName: company.legalName, alternateName: company.legalName }),
    ...(has(company.tagline) ? { slogan: company.tagline, description: `${company.tradingName} — ${company.tagline}. ${placeOf(company)}.` } : {}),
    url: base.replace(/\/+$/, ''),
    ...(logo === null ? {} : { logo: { '@type': 'ImageObject', url: absolute(base, logo) }, image: absolute(base, logo) }),
    ...(phones[0] === undefined ? {} : { telephone: phones[0] }),
    ...(emails[0] === undefined ? {} : { email: emails[0] }),
    address: {
      '@type': 'PostalAddress',
      ...(has(company.streetAddress) ? { streetAddress: company.streetAddress } : {}),
      addressLocality: company.city,
      ...(has(company.countyOrState) ? { addressRegion: company.countyOrState } : {}),
      ...(has(company.postalCode) ? { postalCode: company.postalCode } : {}),
      addressCountry: countryCode(company.country),
    },
    areaServed: [{ '@type': 'City', name: company.city }, { '@type': 'Country', name: company.country }],
    ...(contactPoints.length > 0 ? { contactPoint: contactPoints } : {}),
    ...(sameAs.length > 0 ? { sameAs: [...new Set(sameAs)] } : {}),
  };
}

/** The site itself, with the search box search engines may offer beside the result. */
export function websiteJsonLd(company: Pick<JsonLdCompany, 'tradingName' | 'legalName'>, base: string): Record<string, unknown> {
  const root = base.replace(/\/+$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${root}/#website`,
    url: root,
    name: company.tradingName,
    ...(company.legalName === company.tradingName ? {} : { alternateName: company.legalName }),
    inLanguage: 'en-KE',
    publisher: { '@id': `${root}/#organization` },
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${root}/?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
  };
}

/** Questions and answers exactly as the page shows them. Empty when there are none. */
export function faqJsonLd(faqs: readonly { question: string; answer: string }[]): Record<string, unknown> | null {
  const items = faqs.filter((faq) => has(faq.question) && has(faq.answer)).slice(0, 50);
  if (items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((faq) => ({ '@type': 'Question', name: faq.question, acceptedAnswer: { '@type': 'Answer', text: faq.answer } })),
  };
}

export function itemListJsonLd(name: string, items: readonly { name: string; url: string; image?: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, url: item.url, name: item.name, ...(has(item.image) ? { image: item.image } : {}) })),
  };
}

/** The page that holds the returns or refund policy, when the company wrote one; offers point at it. */
export function returnPolicyPage(policies: readonly PolicyPage[]): PolicyPage | null {
  return policies.find((page) => /return|refund/i.test(`${page.slug} ${page.title}`)) ?? null;
}
