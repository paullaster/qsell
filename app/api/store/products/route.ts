import type { NextRequest } from 'next/server';
import {
  parseStorefrontQuery,
  STOREFRONT_PAGE_SIZE,
  type SearchParamsInput,
} from '@/lib/storefront-search';
import { StorefrontCatalog } from '@/server/domains/catalog/storefront-service';

export const dynamic = 'force-dynamic';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=60',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Public, read-only catalogue feed for business-owned websites. Cursors remain stateless and keyset-paged. */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const params: SearchParamsInput = Object.fromEntries(request.nextUrl.searchParams.entries());
    const query = parseStorefrontQuery(params);
    const page = await StorefrontCatalog.search(query);
    return Response.json(
      {
        products: page.products.map((product) => ({
          id: product.id,
          sku: product.sku,
          name: product.name,
          slug: product.slug,
          description: product.description,
          category: product.category,
          brand: product.brand,
          price: product.price,
          compareAtPrice: product.compareAtPrice,
          taxRate: product.taxRate,
          isTaxInclusive: product.isTaxInclusive,
          stockQuantity: product.stockQuantity,
          baseUnitCode: product.baseUnitCode,
          baseUnitName: product.baseUnitName,
          imageUrl: product.imageUrl,
          additionalImages: product.additionalImages,
          specifications: product.specifications,
          tags: product.tags,
          updatedAt: product.updatedAt,
        })),
        pagination: { limit: STOREFRONT_PAGE_SIZE, total: page.total, nextCursor: page.nextCursor },
      },
      { headers },
    );
  } catch {
    return Response.json(
      { error: 'Product catalogue is temporarily unavailable.' },
      { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } },
    );
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers });
}
