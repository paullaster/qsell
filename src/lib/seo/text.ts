import { has } from '@/lib/values';
import type { PublicProduct } from '@/types/index';
import { productDescriptionPlainText } from '@/lib/productDescription';

/**
 * The words search engines and shared links show, built only from what the company has written (names, tagline,
 * town, categories, guarantees) and from the product. Nothing here names a town, a product or a business: a
 * deployment that sells shoes in Eldoret and one that sells fish in Nairobi each get their own text.
 */

export interface SeoCompany {
  legalName: string;
  tradingName: string;
  tagline: string | null;
  city: string;
  countyOrState: string;
  country: string;
  locationLabel: string | null;
}

/** A text cut to a length at a word, with an ellipsis when it was cut. */
export function clip(text: string, max: number): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max * 0.6 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.|-]+$/, '')}…`;
}

/** "Nairobi, Kenya": the town and country people put in a search. */
export function placeOf(company: Pick<SeoCompany, 'city' | 'country'>): string {
  return [company.city, company.country].map((part) => part.trim()).filter((part) => has(part)).join(', ');
}

/** " in Nairobi, Kenya" for a sentence, or nothing when the company has not entered a town. */
const inPlace = (place: string): string => (has(place) ? ` in ${place}` : '');

/** Words once each, in order, case-insensitively, at most `max`. */
export function uniqueWords(list: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const word = raw.replace(/\s+/g, ' ').trim();
    const key = word.toLowerCase();
    if (!has(word) || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/** An amount for a sentence: "KES 1,250" (two decimals only when there are cents). */
export function priceText(amount: number, currencyCode: string | null): string {
  const number = amount.toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });
  return currencyCode === null ? number : `${currencyCode} ${number}`;
}

/** The shop's front page title: the trading name leads, so a search for the business finds it first. */
export function homeTitle(company: SeoCompany): string {
  const tail = has(company.tagline) ? [company.tagline, company.city].filter((part) => has(part)).join(' | ') : `Online shop${inPlace(placeOf(company))}`;
  return clip(`${company.tradingName} — ${tail}`, 70);
}

export function homeDescription(company: SeoCompany, extras: { categories?: readonly string[]; guarantee?: string } = {}): string {
  const categories = uniqueWords(extras.categories ?? [], 4);
  const lead = has(company.tagline) ? `${company.tradingName} — ${company.tagline}.` : `${company.tradingName}.`;
  const shop = categories.length > 0 ? ` Shop ${categories.join(', ')} and more online${inPlace(placeOf(company))}.` : ` Shop online${inPlace(placeOf(company))}.`;
  const tail = has(extras.guarantee) ? ` ${extras.guarantee}` : ' Easy ordering and secure payment.';
  return clip(`${lead}${shop}${tail}`, 160);
}

export function homeKeywords(company: SeoCompany, categories: readonly string[] = []): string[] {
  const place = placeOf(company);
  const withTown = (text: string): string => (has(company.city) ? `${text} ${company.city}` : '');
  return uniqueWords(
    [
      company.tradingName,
      company.legalName,
      withTown(company.tradingName),
      `${company.tradingName} online`,
      withTown('online shop'),
      has(place) ? `buy online ${place}` : 'buy online',
      ...categories.flatMap((category) => [withTown(category), `buy ${category} online ${company.country}`.trim()]),
    ],
    16,
  );
}

export function categoryTitle(company: SeoCompany, category: string): string {
  return clip(`${category}${inPlace(placeOf(company))}`, 70);
}

export function categoryDescription(company: SeoCompany, category: string): string {
  return clip(`Shop ${category} online from ${company.tradingName}${inPlace(placeOf(company))}. Browse the range, compare prices and order today.`, 160);
}

export interface ProductSeoContext {
  company: SeoCompany;
  currencyCode: string | null;
  /** The first guarantee the company wrote, when there is one. */
  guarantee?: string;
}

const inStock = (product: PublicProduct): boolean => product.stockQuantity - product.reservedQuantity > 0;

export function productTitle(product: PublicProduct, context: ProductSeoContext): string {
  const price = product.price === undefined ? '' : ` – ${priceText(product.price, context.currencyCode)}`;
  return clip(`${product.name}${price}${inPlace(context.company.city)}`, 70);
}

export function productDescription(product: PublicProduct, context: ProductSeoContext): string {
  const written = productDescriptionPlainText(product.description).replace(/\s+/g, ' ').trim();
  const price = product.price === undefined ? '' : ` ${priceText(product.price, context.currencyCode)}.`;
  const stock = inStock(product) ? ' In stock.' : ' Currently out of stock.';
  const seller = ` ${[context.company.tradingName, placeOf(context.company)].filter((part) => has(part)).join(', ')}.`;
  if (written.length >= 50) return clip(`${clip(written, 96)}${price}${stock}${seller}`, 160);
  const brand = has(product.brand) ? ` by ${product.brand}` : '';
  const category = has(product.category) ? ` (${product.category})` : '';
  return clip(`Buy ${product.name}${brand}${category} online${inPlace(placeOf(context.company))}.${price}${stock} Order from ${context.company.tradingName}.`, 160);
}

export function productKeywords(product: PublicProduct, company: SeoCompany): string[] {
  return uniqueWords(
    [
      product.name,
      has(company.city) ? `${product.name} ${company.city}` : '',
      `buy ${product.name} online`,
      product.category,
      product.brand ?? '',
      has(product.category) && has(company.city) ? `${product.category} ${company.city}` : '',
      ...product.tags,
    ],
    14,
  );
}
