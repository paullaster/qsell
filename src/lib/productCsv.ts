/**
 * The product CSV contract, used by both the export (browser) and the bulk
 * import (server). One definition means an exported file can always be edited
 * and imported back, and both sides agree on every column's meaning.
 *
 * Pure: no I/O. Checks that need the database (does the category exist, is the
 * SKU taken) live in the import service.
 */

import type { Product, ProductSpecification } from '@/types/index';
import { guardFormula, toCsv, unguardFormula, UTF8_BOM } from '@/lib/csv';

/** Separator for list-valued cells (tags, extra images, specifications). */
export const LIST_SEPARATOR = '|';

export const MAX_IMPORT_ROWS = 10_000;
/** Stays under the 3 MB server-action body limit in next.config.ts, leaving multipart overhead. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

type ColumnKind =
  'text' | 'money' | 'integer' | 'decimal' | 'status' | 'list' | 'specs' | 'url' | 'urls';

interface ColumnSpec {
  /** Canonical header, as exported. */
  header: string;
  /** Other accepted spellings (older exports, obvious synonyms). */
  aliases?: readonly string[];
  kind: ColumnKind;
  required: boolean;
  /** Present in exports for reference but ignored on import. */
  exportOnly?: boolean;
  help: string;
  example: string;
}

export const PRODUCT_CSV_COLUMNS = [
  {
    header: 'SKU',
    kind: 'text',
    required: true,
    help: 'Customer-facing code. Unique; stored in upper case.',
    example: 'SOL-PNL-400',
  },
  {
    header: 'Stock_Code',
    kind: 'text',
    required: true,
    help: 'Internal stock-control code. Unique; stored in upper case.',
    example: 'STK-000123',
  },
  {
    header: 'Name',
    aliases: ['Title', 'Product_Title'],
    kind: 'text',
    required: true,
    help: 'Product title shown to shoppers.',
    example: '400W Solar Panel',
  },
  {
    header: 'Slug',
    kind: 'text',
    required: false,
    help: 'URL name. Leave blank to generate one from the name.',
    example: '',
  },
  {
    header: 'Category',
    kind: 'text',
    required: true,
    help: 'Name of an existing category (not case-sensitive).',
    example: 'Solar Panels',
  },
  {
    header: 'Item_Type',
    kind: 'text',
    required: false,
    help: 'Name or number code of an existing item type. Blank uses the default item type.',
    example: '',
  },
  {
    header: 'Price',
    aliases: ['Price_KES', 'Selling_Price'],
    kind: 'money',
    required: false,
    help: 'Selling price in the base currency. Required (above 0) for sellable item types.',
    example: '18500.00',
  },
  {
    header: 'Compare_At_Price',
    kind: 'money',
    required: false,
    help: 'Optional "was" price, above 0.',
    example: '',
  },
  {
    header: 'Cost_Price',
    aliases: ['Cost_KES', 'Cost', 'Cost_Of_Goods'],
    kind: 'money',
    required: true,
    help: 'Unit cost of goods, 0 or more.',
    example: '12000.00',
  },
  {
    header: 'Tax_Category',
    kind: 'text',
    required: false,
    help: 'Name or code of an existing tax category. Blank uses the default.',
    example: '',
  },
  {
    header: 'Stock_Qty',
    aliases: ['Stock_Quantity', 'Quantity'],
    kind: 'integer',
    required: false,
    help: 'Opening stock, a whole number. Blank means 0.',
    example: '25',
  },
  {
    header: 'Low_Stock_Threshold',
    kind: 'integer',
    required: false,
    help: 'Alert level, a whole number. Blank means 0.',
    example: '5',
  },
  {
    header: 'Weight_Kg',
    aliases: ['Weight'],
    kind: 'decimal',
    required: false,
    help: 'Weight in kilograms.',
    example: '21.5',
  },
  { header: 'Brand', kind: 'text', required: false, help: 'Optional brand.', example: 'SunKing' },
  {
    header: 'Description',
    kind: 'text',
    required: false,
    help: 'Line breaks allowed. Use "## Heading" lines for sections.',
    example: '## Package\nPanel, mounting brackets and cables.',
  },
  {
    header: 'Image_URL',
    aliases: ['Primary_Image_URL'],
    kind: 'url',
    required: false,
    help: 'https:// link (or /path) to the main image.',
    example: 'https://example.com/panel.jpg',
  },
  {
    header: 'Additional_Image_URLs',
    kind: 'urls',
    required: false,
    help: `More image links, separated by "${LIST_SEPARATOR}".`,
    example: '',
  },
  {
    header: 'Tags',
    kind: 'list',
    required: false,
    help: `Tags separated by "${LIST_SEPARATOR}".`,
    example: 'solar|outdoor',
  },
  {
    header: 'Specifications',
    kind: 'specs',
    required: false,
    help: `"Label: value" pairs separated by "${LIST_SEPARATOR}".`,
    example: 'Wattage: 400W|Warranty: 10 years',
  },
  {
    header: 'Status',
    kind: 'status',
    required: false,
    help: 'Active or Draft. Blank means Active.',
    example: 'Active',
  },
  {
    header: 'Reserved_Qty',
    kind: 'integer',
    required: false,
    exportOnly: true,
    help: 'Export only — ignored on import.',
    example: '',
  },
] as const satisfies readonly ColumnSpec[];

export type ProductCsvHeader = (typeof PRODUCT_CSV_COLUMNS)[number]['header'];

/** A product row that passed format checks, before database checks. */
export interface ProductImportDraft {
  sku: string;
  stockCode: string;
  name: string;
  slug: string | null;
  categoryName: string;
  itemTypeRef: string | null;
  price: number | null;
  compareAtPrice: number | null;
  costPrice: number;
  taxRef: string | null;
  stockQuantity: number;
  lowStockThreshold: number;
  weight: number | null;
  brand: string | null;
  description: string;
  imageUrl: string;
  additionalImages: string[];
  tags: string[];
  specifications: ProductSpecification[];
  isActive: boolean;
}

export interface CellError {
  column: string;
  message: string;
}

// ── Headers ─────────────────────────────────────────────────────────────────

const normaliseHeader = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_');

const HEADER_LOOKUP = new Map<string, ColumnSpec>(
  PRODUCT_CSV_COLUMNS.flatMap((column: ColumnSpec) =>
    [column.header, ...(column.aliases ?? [])].map(
      (name) => [normaliseHeader(name), column] as const,
    ),
  ),
);

export type HeaderMap = Map<ProductCsvHeader, number>;

/** Map canonical headers to column positions, or explain what is wrong with the header row. */
export function resolveHeaders(
  headerFields: readonly string[],
): { ok: true; map: HeaderMap } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const map: HeaderMap = new Map();
  const unknown: string[] = [];

  headerFields.forEach((raw, index) => {
    const name = raw.replace(/^\uFEFF/, '').trim();
    if (name === '') return;
    const column = HEADER_LOOKUP.get(normaliseHeader(name));
    if (!column) {
      unknown.push(name);
      return;
    }
    const header = column.header as ProductCsvHeader;
    if (map.has(header)) {
      errors.push(`Column "${column.header}" appears more than once.`);
      return;
    }
    map.set(header, index);
  });

  if (unknown.length > 0) {
    errors.push(
      `Unrecognised column${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => `"${u}"`).join(', ')}. Download the template for the exact column names.`,
    );
  }
  const missing = PRODUCT_CSV_COLUMNS.filter((c) => c.required && !map.has(c.header));
  if (missing.length > 0) {
    errors.push(
      `Missing required column${missing.length === 1 ? '' : 's'}: ${missing.map((c) => c.header).join(', ')}.`,
    );
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, map };
}

// ── Cell parsing ────────────────────────────────────────────────────────────

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const DECIMAL = /^\d{1,8}(\.\d{1,4})?$/;
const INTEGER = /^\d{1,9}$/;
const MAX_TEXT = 200;
const MAX_DESCRIPTION = 20_000;

function isUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function splitList(value: string): string[] {
  return value
    .split(LIST_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function numberHint(value: string): string {
  return /[,\s]/.test(value) ? ' Remove thousands separators and spaces.' : '';
}

/**
 * Format-check one data row. Returns a draft only when every cell is valid;
 * otherwise every problem found in the row, so the user can fix them in one pass.
 */
export function parseProductRow(
  fields: readonly string[],
  headers: HeaderMap,
): { ok: true; draft: ProductImportDraft } | { ok: false; errors: CellError[] } {
  const errors: CellError[] = [];
  const cell = (header: ProductCsvHeader): string => {
    const index = headers.get(header);
    const raw = index === undefined ? '' : (fields[index] ?? '');
    return unguardFormula(raw.replace(/\r\n?/g, '\n')).trim();
  };
  const fail = (column: string, message: string) => {
    errors.push({ column, message });
  };

  const text = (header: ProductCsvHeader, required: boolean, max = MAX_TEXT): string => {
    const value = cell(header);
    if (required && value === '') fail(header, 'is required.');
    else if (value.length > max) fail(header, `is too long (max ${max} characters).`);
    return value;
  };
  const money = (header: ProductCsvHeader): number | null => {
    const value = cell(header);
    if (value === '') return null;
    if (!MONEY.test(value)) {
      fail(
        header,
        `"${value}" is not a valid amount. Use digits with up to 2 decimals, e.g. 1500.00.${numberHint(value)}`,
      );
      return null;
    }
    return Number(value);
  };
  const integer = (header: ProductCsvHeader): number => {
    const value = cell(header);
    if (value === '') return 0;
    if (!INTEGER.test(value)) {
      fail(header, `"${value}" must be a whole number of 0 or more.${numberHint(value)}`);
      return 0;
    }
    return Number(value);
  };

  const sku = text('SKU', true, 64).toUpperCase();
  const stockCode = text('Stock_Code', true, 64).toUpperCase();
  const name = text('Name', true);
  const slugRaw = text('Slug', false, 200).toLowerCase();
  if (slugRaw !== '' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugRaw)) {
    fail('Slug', 'may only contain lower-case letters, digits and single hyphens.');
  }
  const categoryName = text('Category', true);
  const itemTypeRef = text('Item_Type', false);
  // Whether 0 is allowed depends on the item type (sellable needs > 0): checked by the import service.
  const price = money('Price');
  const compareAtPrice = money('Compare_At_Price');
  if (compareAtPrice !== null && compareAtPrice <= 0)
    fail('Compare_At_Price', 'must be greater than 0 when provided.');
  const costRaw = cell('Cost_Price');
  const costPrice = money('Cost_Price');
  if (costRaw === '') fail('Cost_Price', 'is required (use 0 if the item has no cost).');
  const taxRef = text('Tax_Category', false);
  const stockQuantity = integer('Stock_Qty');
  const lowStockThreshold = integer('Low_Stock_Threshold');

  const weightRaw = cell('Weight_Kg');
  let weight: number | null = null;
  if (weightRaw !== '') {
    if (DECIMAL.test(weightRaw)) weight = Number(weightRaw);
    else
      fail('Weight_Kg', `"${weightRaw}" is not a valid weight. Use digits with up to 4 decimals.`);
  }

  const brand = text('Brand', false);
  const description = text('Description', false, MAX_DESCRIPTION);

  const imageUrl = cell('Image_URL');
  if (imageUrl !== '' && !isUrl(imageUrl)) fail('Image_URL', 'must start with https:// or /.');
  const additionalImages = splitList(cell('Additional_Image_URLs'));
  if (additionalImages.some((url) => !isUrl(url))) {
    fail(
      'Additional_Image_URLs',
      `every link must start with https:// or /, separated by "${LIST_SEPARATOR}".`,
    );
  }
  const tags = [...new Set(splitList(cell('Tags')))];

  const specifications: ProductSpecification[] = [];
  for (const pair of splitList(cell('Specifications'))) {
    const separator = pair.indexOf(':');
    const key = separator > 0 ? pair.slice(0, separator).trim() : '';
    const value = separator > 0 ? pair.slice(separator + 1).trim() : '';
    if (key === '' || value === '') {
      fail('Specifications', `"${pair}" should look like "Label: value".`);
    } else {
      specifications.push({ key, value });
    }
  }

  const statusRaw = cell('Status').toLowerCase();
  let isActive = true;
  if (statusRaw === 'draft' || statusRaw === 'inactive') isActive = false;
  else if (statusRaw !== '' && statusRaw !== 'active')
    fail('Status', `"${cell('Status')}" must be Active or Draft.`);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      sku,
      stockCode,
      name,
      slug: slugRaw === '' ? null : slugRaw,
      categoryName,
      itemTypeRef: itemTypeRef === '' ? null : itemTypeRef,
      price,
      compareAtPrice,
      costPrice: costPrice ?? 0,
      taxRef: taxRef === '' ? null : taxRef,
      stockQuantity,
      lowStockThreshold,
      weight,
      brand: brand === '' ? null : brand,
      description,
      imageUrl,
      additionalImages,
      tags,
      specifications,
      isActive,
    },
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

// ── Export ──────────────────────────────────────────────────────────────────

const money2 = (value: number | undefined | null) => (value == null ? '' : value.toFixed(2));

function exportCells(product: Product): Record<ProductCsvHeader, string> {
  return {
    SKU: product.sku,
    Stock_Code: product.stockCode,
    Name: product.name,
    Slug: product.slug,
    Category: product.category,
    Item_Type: product.itemTypeName,
    Price: money2(product.price),
    Compare_At_Price: money2(product.compareAtPrice),
    Cost_Price: money2(product.costPrice),
    Tax_Category: product.taxCategoryName ?? '',
    Stock_Qty: String(product.stockQuantity),
    Low_Stock_Threshold: String(product.lowStockThreshold),
    Weight_Kg: product.weight == null ? '' : String(product.weight),
    Brand: product.brand ?? '',
    Description: product.description,
    Image_URL: product.imageUrl,
    Additional_Image_URLs: (product.additionalImages ?? []).join(LIST_SEPARATOR),
    Tags: product.tags.join(LIST_SEPARATOR),
    Specifications: (product.specifications ?? [])
      .map((s) => `${s.key}: ${s.value}`)
      .join(LIST_SEPARATOR),
    Status: product.isActive ? 'Active' : 'Draft',
    Reserved_Qty: String(product.reservedQuantity),
  };
}

const TEXT_KINDS = new Set<ColumnKind>(['text', 'list', 'specs', 'url', 'urls', 'status']);

/** Full CSV document (BOM + header + rows) for the given products. */
export function buildProductsCsv(products: readonly Product[]): string {
  const header = PRODUCT_CSV_COLUMNS.map((c) => c.header);
  const rows = products.map((product) => {
    const cells = exportCells(product);
    return PRODUCT_CSV_COLUMNS.map((column: ColumnSpec) => {
      const value = cells[column.header as ProductCsvHeader];
      // Only text is guarded: numbers are never formulas and must stay numeric.
      return TEXT_KINDS.has(column.kind) ? guardFormula(value) : value;
    });
  });
  return UTF8_BOM + toCsv([header, ...rows]);
}

/** Import template: header plus one example row using real reference names when available. */
export function buildProductTemplateCsv(examples: {
  category?: string;
  itemType?: string;
  taxCategory?: string;
}): string {
  const header = PRODUCT_CSV_COLUMNS.filter((c: ColumnSpec) => c.exportOnly !== true).map(
    (c) => c.header,
  );
  const row = PRODUCT_CSV_COLUMNS.filter((c: ColumnSpec) => c.exportOnly !== true).map((column) => {
    if (column.header === 'Category') return examples.category ?? column.example;
    if (column.header === 'Item_Type') return examples.itemType ?? column.example;
    if (column.header === 'Tax_Category') return examples.taxCategory ?? column.example;
    return column.example;
  });
  return UTF8_BOM + toCsv([header, row]);
}

/** Human-readable column guide for the import dialog. */
export function productCsvColumnGuide(): { header: string; required: boolean; help: string }[] {
  return PRODUCT_CSV_COLUMNS.filter((c: ColumnSpec) => c.exportOnly !== true).map((c) => ({
    header: c.header,
    required: c.required,
    help: c.help,
  }));
}
