import { has } from '@/lib/values';
import { placeOf, type SeoCompany } from './text';

export interface AboutView {
  heading: string;
  paragraphs: string[];
  categories: { name: string; slug: string }[];
}

/** The text under the products on the shop's front page: who the shop is, where, and what it sells. Written only from what the company entered. */
export function aboutView(
  company: SeoCompany & { streetAddress: string },
  categories: readonly { name: string; slug: string; depth: number }[],
  guarantees: readonly string[],
): AboutView {
  const top = categories.filter((category) => category.depth === 0).slice(0, 8);
  const place = placeOf(company);
  const where = has(place) ? ` based in ${place}${has(company.locationLabel) ? `, ${company.locationLabel}` : ''}` : '';
  const first = has(company.tagline) ? `${company.tradingName} — ${company.tagline}.${has(where) ? ` We are${where}.` : ''}` : `${company.tradingName} is an online shop${where}.`;
  const sells = top.length > 0 ? `Shop ${top.map((category) => category.name).join(', ')} and more, and order online${has(company.country) ? ` from anywhere in ${company.country}` : ''}.` : 'Order online today.';
  return {
    heading: `About ${company.tradingName}`,
    paragraphs: [first, sells, ...guarantees.slice(0, 2)],
    categories: top.map(({ name, slug }) => ({ name, slug })),
  };
}
