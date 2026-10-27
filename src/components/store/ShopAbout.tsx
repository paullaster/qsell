import Link from 'next/link';
import { StorefrontCatalog } from '@/server/domains/catalog/storefront-service';
import { storefrontSeo } from '@/server/domains/storefront/seo';
import { aboutView } from '@/lib/seo/about';
import { hasStorefrontFilters, storefrontHref, type StorefrontQuery } from '@/lib/storefront-search';

/** Plain text about the shop under the products, only on the unfiltered front page. It gives a search engine the shop's name, town and range in words. */
export async function ShopAbout({ queryPromise }: { queryPromise: Promise<StorefrontQuery> }) {
  const query = await queryPromise;
  if (hasStorefrontFilters(query) || query.cursor !== null) return null;
  const [{ company, ui }, categories] = await Promise.all([storefrontSeo(), StorefrontCatalog.categories()]);
  const view = aboutView(company, categories, ui.support.guarantees.map((guarantee) => guarantee.text));
  return (
    <section aria-labelledby="about-shop" className="mt-12 max-w-3xl space-y-3 border-t border-line pt-8">
      <h2 id="about-shop" className="text-xl font-bold text-fg-strong">{view.heading}</h2>
      {view.paragraphs.map((text) => (
        <p key={text} className="text-sm leading-relaxed text-fg-muted">{text}</p>
      ))}
      {view.categories.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Categories">
          {view.categories.map((category) => (
            <li key={category.slug}>
              <Link href={storefrontHref({ category: category.slug })} className="inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm text-fg hover:bg-surface-muted">{category.name}</Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
