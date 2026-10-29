import { describe, expect, it } from 'vitest';
import type { PublicProduct } from '@/types/index';
import { publicStoreProduct } from './public-store-product';

describe('publicStoreProduct', () => {
  it('keeps storefront details and excludes internal inventory fields', () => {
    const product = {
      id: 'product-1',
      sku: 'SOL-1',
      stockCode: 'STOCK-1',
      name: 'Solar panel',
      slug: 'solar-panel',
      description: 'A high-efficiency solar panel.',
      category: 'Solar panels',
      brand: 'SM Solar',
      itemTypeId: 'sellable',
      itemTypeName: 'Goods',
      itemTypeCode: 1,
      isSellable: true,
      price: 100,
      costPrice: 50,
      standardPrice: 100,
      compareAtPrice: 120,
      taxCategoryId: 'tax-category',
      taxCategoryName: 'VAT',
      taxRate: 16,
      isTaxInclusive: true,
      weight: 20,
      baseUnitId: 'piece',
      baseUnitCode: 'PCS',
      baseUnitName: 'piece',
      baseUnitDecimals: 0,
      specifications: [{ key: 'Power', value: '620 W' }],
      stockQuantity: 8,
      reservedQuantity: 2,
      lowStockThreshold: 1,
      isActive: true,
      imageUrl: 'https://images.example.com/panel.jpg',
      additionalImages: ['https://images.example.com/panel-back.jpg'],
      rating: 0,
      reviewCount: 0,
      tags: ['solar', 'panel'],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    } satisfies PublicProduct & { costPrice: number; stockCode: string };

    expect(publicStoreProduct(product)).toEqual({
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
    });
    expect(publicStoreProduct(product)).not.toHaveProperty('costPrice');
    expect(publicStoreProduct(product)).not.toHaveProperty('stockCode');
    expect(publicStoreProduct(product)).not.toHaveProperty('reservedQuantity');
  });
});
