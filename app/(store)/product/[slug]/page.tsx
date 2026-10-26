import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { Suspense } from 'react';
import { StorefrontCatalog } from '@/server/domains/catalog/storefront-service';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { publicProduct } from '@/server/domains/storefront/product-page';
import { siteBaseUrl } from '@/server/domains/storefront/site';
import { shopCurrency } from '@/server/domains/storefront/shell';
import { ProductDescriptionView } from '@/components/ui/ProductDescriptionView';
import { ProductGallery } from '@/components/store/product/ProductGallery';
import { MobileBuyBar } from '@/components/store/product/MobileBuyBar';
import { ProductReviews } from '@/components/store/product/ProductReviews';
import { productReviewsAction } from '@/server/domains/reviews/actions';
import { ProductPurchase } from '@/components/store/product/ProductPurchase';
import { RecentlyViewed } from '@/components/store/product/RecentlyViewed';
import { RelatedProducts } from '@/components/store/product/RelatedProducts';
import { WishlistButton } from '@/components/store/wishlist/WishlistButton';
import { ShareButton } from '@/components/store/product/ShareButton';
import { Price } from '@/components/store/Price';
import { Rating } from '@/components/store/Rating';
import { StockBadge } from '@/components/store/StockBadge';
import { productDescriptionPlainText } from '@/lib/productDescription';
import { absoluteUrl, breadcrumbJsonLd, jsonLdText, metaDescription, productImages, productJsonLd } from '@/lib/product-seo';
import { visibleSpecifications } from '@/lib/product-specifications';
import { storefrontHref } from '@/lib/storefront-search';
import { productHref } from '@/lib/product-link';
import { has } from '@/lib/values';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const product = await publicProduct((await params).slug);
  if (product === null) return { title: 'Product not found', robots: { index: false } };
  const written = metaDescription(productDescriptionPlainText(product.description));
  const description = written === '' ? `Buy ${product.name} online.` : written;
  const image = productImages(product)[0];
  const base = await siteBaseUrl();
  return {
    title: product.name,
    description,
    alternates: { canonical: productHref(product) },
    openGraph: {
      type: 'website',
      title: product.name,
      description,
      url: absoluteUrl(base, productHref(product)),
      ...(image === undefined ? {} : { images: [{ url: absoluteUrl(base, image), alt: product.name }] }),
    },
    twitter: { card: image === undefined ? 'summary' : 'summary_large_image', title: product.name, description },
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  // Decided before anything is drawn: a product that is not for sale is a 404, not an empty page.
  const [product, categories] = await Promise.all([publicProduct(slug), StorefrontCatalog.categories().catch(() => [])]);
  if (product === null) notFound();
  // An older link by id, or a name that has since changed, goes to the product's current readable address.
  if (slug !== productHref(product).slice('/product/'.length)) permanentRedirect(productHref(product));

  const [company, currency, base] = await Promise.all([getCompanySettingsAction(), shopCurrency(), siteBaseUrl()]);
  const category = categories.find((item) => item.name === product.category) ?? null;
  const specifications = visibleSpecifications(product.specifications);
  const images = productImages(product);
  const trail = [
    { name: 'Shop', url: absoluteUrl(base, '/') },
    ...(category === null ? [] : [{ name: category.name, url: absoluteUrl(base, storefrontHref({ category: category.slug })) }]),
    { name: product.name, url: absoluteUrl(base, productHref(product)) },
  ];

  return (
    <article className="space-y-10 pb-24 md:pb-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(productJsonLd(product, { baseUrl: base, currencyCode: currency?.code ?? null, storeName: company.tradingName })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(breadcrumbJsonLd(trail)) }} />

      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
          <li><Link href="/" className="inline-flex min-h-9 items-center hover:text-fg-strong hover:underline">Shop</Link></li>
          {category === null ? null : (
            <li className="flex items-center gap-2">
              <span aria-hidden="true">/</span>
              <Link href={storefrontHref({ category: category.slug })} className="inline-flex min-h-9 items-center hover:text-fg-strong hover:underline">{category.name}</Link>
            </li>
          )}
          <li aria-current="page" className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true">/</span>
            <span className="truncate font-medium text-fg-strong">{product.name}</span>
          </li>
        </ol>
      </nav>

      <div className="grid gap-8 md:grid-cols-2 lg:gap-12">
        <ProductGallery images={images} name={product.name} />

        <div className="min-w-0 space-y-5 md:sticky md:top-24 md:self-start">
          <div className="space-y-2">
            {has(product.brand) ? <p className="text-sm font-semibold tracking-wide text-indigo-500 uppercase">{product.brand}</p> : null}
            <h1 className="text-2xl leading-tight font-bold text-fg-strong sm:text-3xl">{product.name}</h1>
            <div className="flex flex-wrap items-center gap-3">
              <Rating rating={product.rating} reviewCount={product.reviewCount} />
              <StockBadge product={product} />
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4">
            <Price product={product} size="lg" />
          </div>

          <div id="buy-panel"><ProductPurchase product={product} /></div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-sm text-fg-muted">
            <span>SKU: <span className="font-mono text-fg">{product.sku}</span></span>
            <span className="flex flex-wrap items-center gap-1"><WishlistButton product={product} variant="text" /><ShareButton title={product.name} /></span>
          </div>
        </div>
      </div>

      {productDescriptionPlainText(product.description) === '' ? null : (
        <section aria-labelledby="product-description" className="max-w-3xl space-y-3">
          <h2 id="product-description" className="text-xl font-bold text-fg-strong">Description</h2>
          <ProductDescriptionView description={product.description} />
        </section>
      )}

      {specifications.length > 0 ? (
        <section aria-labelledby="product-specifications" className="max-w-3xl space-y-3">
          <h2 id="product-specifications" className="text-xl font-bold text-fg-strong">Specifications</h2>
          <dl className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
            {specifications.map((spec) => (
              <div key={`${spec.key}:${spec.value}`} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-4 py-3">
                <dt className="font-medium break-words text-fg-muted">{spec.key}</dt>
                <dd className="break-words text-fg-strong">{spec.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section aria-labelledby="product-reviews" className="max-w-3xl space-y-3">
        <h2 id="product-reviews" className="text-xl font-bold text-fg-strong">Reviews</h2>
        <Suspense fallback={<p role="status" className="text-sm text-fg-muted">Loading reviews…</p>}>
          <ProductReviews productId={product.id} slug={productHref(product).slice('/product/'.length)} firstPage={productReviewsAction({ productId: product.id })} />
        </Suspense>
      </section>

      <Suspense fallback={null}>
        <RelatedProducts productsPromise={StorefrontCatalog.related(product)} />
      </Suspense>
      <RecentlyViewed productId={product.id} />
      <MobileBuyBar product={product} targetId="buy-panel" />
    </article>
  );
}
