import type { Product } from '@/types/index';
import type { CatalogueEntry } from '@/lib/quote-layout';

/**
 * What the quote and template editors need to know about a product. The full record carries
 * descriptions, specifications and media, which a long catalogue should not send to the browser.
 */
export type CatalogueProduct = Pick<
  Product,
  | 'id'
  | 'sku'
  | 'stockCode'
  | 'name'
  | 'category'
  | 'brand'
  | 'isSellable'
  | 'price'
  | 'costPrice'
  | 'taxRate'
  | 'isTaxInclusive'
  | 'stockQuantity'
  | 'reservedQuantity'
  | 'imageUrl'
>;

/** A sellable product with its searchable text worked out once, so each keystroke only filters. */
export interface CatalogueIndexEntry {
  product: CatalogueProduct;
  haystack: string;
  codes: string[];
}

export const buildCatalogueIndex = (products: CatalogueProduct[]): CatalogueIndexEntry[] =>
  products
    .filter((p) => p.isSellable)
    .map((product) => ({
      product,
      haystack:
        `${product.name} ${product.sku} ${product.stockCode} ${product.brand ?? ''} ${product.category}`.toLowerCase(),
      codes: [product.sku, product.stockCode].map((c) => c.toLowerCase()),
    }));

/**
 * Items whose text holds every word typed (in any order), optionally in one category. A query that
 * is exactly an item's SKU or stock code puts that item first, so a scanned code lands on top.
 */
export function searchCatalogue(
  index: CatalogueIndexEntry[],
  query: string,
  category = 'all',
): CatalogueIndexEntry[] {
  const exact = query.trim().toLowerCase();
  const words = exact.split(/\s+/).filter(Boolean);
  const found = index.filter(
    (e) =>
      (category === 'all' || e.product.category === category) &&
      words.every((w) => e.haystack.includes(w)),
  );
  if (!exact) return found;
  return [
    ...found.filter((e) => e.codes.includes(exact)),
    ...found.filter((e) => !e.codes.includes(exact)),
  ];
}

/** What is typed for one item, as the fields hold it. */
export interface Draft {
  quantity: string;
  price: string;
  discount: string;
}
export const blankDraft: Draft = { quantity: '1', price: '', discount: '' };

/** The values typed for one item, or what is wrong with them. */
export function readDraft(
  draft: Draft,
  product: Pick<CatalogueProduct, 'id' | 'price'>,
): { entry: Omit<CatalogueEntry, 'sectionId'> } | { error: string } {
  const quantity = Number(draft.quantity);
  if (draft.quantity.trim() === '' || !Number.isFinite(quantity) || quantity <= 0) {
    return { error: 'Quantity must be above zero.' };
  }
  const price = draft.price.trim() === '' ? null : Number(draft.price);
  if (price !== null && (!Number.isFinite(price) || price < 0)) {
    return { error: 'Price must be zero or more.' };
  }
  if (price === null && product.price == null) {
    return { error: 'This item has no catalogue price. Type a price to add it.' };
  }
  const discount = draft.discount.trim() === '' ? 0 : Number(draft.discount);
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
    return { error: 'Discount must be between 0 and 100.' };
  }
  return {
    entry: { productId: product.id, quantity, unitPrice: price, discountPercent: discount },
  };
}

/** Most rows a pasted list may hold. Beyond this, the rest is left out with a note. */
export const BULK_MAX_ROWS = 5000;

export interface BulkRow {
  /** 1-based line in the pasted text. */
  line: number;
  product: CatalogueProduct;
  entry: Omit<CatalogueEntry, 'sectionId'>;
}
export interface BulkProblem {
  line: number;
  text: string;
  message: string;
}

const HEADER = new Set(['sku', 'code', 'stock code', 'stockcode', 'item', 'item code', 'product']);

const cells = (line: string): string[] => {
  const parts = line.includes('\t')
    ? line.split('\t')
    : line.includes(',')
      ? line.split(',')
      : line.includes(';')
        ? line.split(';')
        : line.trim().split(/\s+/);
  return parts.map((c) =>
    c
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim(),
  );
};

/**
 * Reads a pasted or imported list: one item per line as `code, quantity, price, discount`, split by
 * commas, tabs (a spreadsheet paste), semicolons or spaces. The code is an item's SKU or stock code;
 * quantity defaults to 1, and an empty price or discount means "as usual". A header row is skipped.
 * Each line is either a row ready to add or a problem saying why not.
 */
export function parseBulkList(
  text: string,
  index: CatalogueIndexEntry[],
): { rows: BulkRow[]; problems: BulkProblem[]; truncated: boolean } {
  const byCode = new Map<string, CatalogueProduct>();
  for (const e of index)
    for (const code of e.codes) if (code && !byCode.has(code)) byCode.set(code, e.product);

  const rows: BulkRow[] = [];
  const problems: BulkProblem[] = [];
  const lines = text.split(/\r?\n/);
  let seenData = false;
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const [code = '', quantity = '', price = '', discount = ''] = cells(raw);
    if (!seenData) {
      seenData = true;
      if (HEADER.has(code.toLowerCase()) && !Number.isFinite(Number(quantity || NaN))) continue;
    }
    if (rows.length + problems.length >= BULK_MAX_ROWS) {
      truncated = true;
      break;
    }
    const product = byCode.get(code.toLowerCase());
    if (!product) {
      problems.push({
        line: i + 1,
        text: raw.trim(),
        message: `No product has the code “${code}”.`,
      });
      continue;
    }
    const result = readDraft(
      { quantity: quantity === '' ? '1' : quantity, price, discount },
      product,
    );
    if ('error' in result) problems.push({ line: i + 1, text: raw.trim(), message: result.error });
    else rows.push({ line: i + 1, product, entry: result.entry });
  }
  return { rows, problems, truncated };
}
