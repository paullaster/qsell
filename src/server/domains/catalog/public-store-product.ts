import type { PublicProduct } from '@/types/index';

/** The explicit public website/storefront contract. Keep internal inventory and cost fields out. */
export function publicStoreProduct(product: PublicProduct) {
  return {
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
  };
}
