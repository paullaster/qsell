import { cache } from 'react';
import type { PublicProduct } from '@/types/index';
import { CatalogService } from '@/server/domains/catalog/service';

/** The product a shopper asked for, by its readable address or its id, read once however many parts of the page ask (the page and its metadata). Null when it is not for sale. */
export const publicProduct = cache(async (key: string): Promise<PublicProduct | null> => {
  // A malformed address is a missing product, not an error.
  if (key.length === 0 || key.length > 160) return null;
  return (await CatalogService.getPublicProductByKey(key)) ?? null;
});
