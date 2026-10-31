import type { NextRequest } from 'next/server';
import { withShopAvailability } from '@/server/domains/catalog/shop-availability';
import { withShopPrices } from '@/server/domains/catalog/shop-prices';
import { CatalogService } from '@/server/domains/catalog/service';
import { publicStoreProduct } from '@/server/domains/catalog/public-store-product';

export const dynamic = 'force-dynamic';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=60',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** One currently sellable product for the public website's detail view. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await params;
    if (slug.length === 0 || slug.length > 160) {
      return Response.json({ error: 'Product not found.' }, { status: 404, headers });
    }
    const product = await CatalogService.getPublicProductByKey(slug);
    if (product === undefined) {
      return Response.json({ error: 'Product not found.' }, { status: 404, headers });
    }
    const priced = (await withShopPrices(await withShopAvailability([product])))[0];
    if (priced === undefined) {
      return Response.json({ error: 'Product not found.' }, { status: 404, headers });
    }
    return Response.json(publicStoreProduct(priced), { headers });
  } catch {
    return Response.json(
      { error: 'Product details are temporarily unavailable.' },
      { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } },
    );
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers });
}
