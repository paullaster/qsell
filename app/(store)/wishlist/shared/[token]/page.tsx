import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductCard } from '@/components/store/ProductCard';
import { StorefrontCatalog } from '@/server/domains/catalog/storefront-service';
import { WishlistService } from '@/server/domains/wishlist/service';
import { readWishlistShareToken } from '@/server/domains/wishlist/share-token';
import { has } from '@/lib/values';

export const metadata: Metadata = {
  title: 'Shared saved products',
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ token: string }>;
}

export default async function SharedWishlistPage({ params }: Props) {
  const { token } = await params;
  const secret = process.env.AUTH_SECRET;
  if (!has(secret)) notFound();
  const claims = readWishlistShareToken(token, new Date(), secret);
  if (claims === null) notFound();

  const ids = await WishlistService.ids(claims.userId);
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(ids.length / 100) }, (_, page) =>
      StorefrontCatalog.productsByIds(ids.slice(page * 100, page * 100 + 100)),
    ),
  );
  const byId = new Map(pages.flat().map((product) => [product.id, product]));
  const products = ids.flatMap((id) => {
    const product = byId.get(id);
    return product === undefined ? [] : [product];
  });

  return (
    <main className="space-y-6 pb-16">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-fg-strong sm:text-3xl">
          Shared saved products
        </h1>
        <p className="text-sm text-fg-muted">This private wishlist link expires after 30 days.</p>
      </header>
      {products.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-raised p-5 text-sm text-fg-muted">
          No saved products in this list are currently available.
        </p>
      ) : (
        <ul
          aria-label="Shared saved products"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {products.map((product) => (
            <li key={product.id} className="contents">
              <ProductCard product={product} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
