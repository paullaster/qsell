import { and, eq, isNull, ne, type SQL } from 'drizzle-orm';
import { unitsOfMeasure } from '@/server/db/drizzle/schema';
import { UNIT_KINDS, isUnitKind, trimmedDecimal } from '@/lib/unit-rules';
import { parseDecimal } from '@/lib/decimal';
import { getContainer } from '@/server/di/container';
import {
  acceptFilters,
  LookupFilterError,
  staticSource,
  tableSource,
  type LookupSource,
} from '@/server/domains/lookups/runner';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The words shown for a unit: "KG · Kilogram". */
const optionOf = (row: Record<string, unknown>) => ({
  id: text(row.id),
  label: `${text(row.label)} · ${text(row.name)}`,
  description: null,
  badge: row.isDefault === true ? 'Default' : null,
  meta: {
    code: text(row.label),
    name: text(row.name),
    decimals: typeof row.decimals === 'number' ? String(row.decimals) : '0',
    kind: text(row.kind),
  },
});

/**
 * The units that are on, for choosing a product's unit. Filters: `kind` (one family), `exclude` (one unit left
 * out, such as the product's own base unit when choosing an alternate), `bases` ("1" for family bases only,
 * for choosing what a new unit is a multiple of).
 */
const units = tableSource({
  key: 'units-of-measure',
  permission: 'products:read',
  table: unitsOfMeasure,
  id: unitsOfMeasure.id,
  label: unitsOfMeasure.code,
  searchColumns: [unitsOfMeasure.code, unitsOfMeasure.name, unitsOfMeasure.symbol],
  select: {
    name: unitsOfMeasure.name,
    decimals: unitsOfMeasure.decimals,
    kind: unitsOfMeasure.kind,
    isDefault: unitsOfMeasure.isDefault,
  },
  scope: ({ filters }) => {
    const { kind, exclude, bases, ...rest } = filters;
    if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
    const conditions: SQL[] = [eq(unitsOfMeasure.isActive, true)];
    if (kind !== undefined) {
      if (!isUnitKind(kind)) throw new LookupFilterError('That is not a valid choice.');
      conditions.push(eq(unitsOfMeasure.kind, kind));
    }
    if (exclude !== undefined) {
      if (!UUID.test(exclude)) throw new LookupFilterError('That is not a valid choice.');
      conditions.push(ne(unitsOfMeasure.id, exclude));
    }
    if (bases !== undefined) {
      if (bases !== '1') throw new LookupFilterError('That is not a valid choice.');
      conditions.push(ne(unitsOfMeasure.kind, 'packaging'), isNull(unitsOfMeasure.baseUnitId));
    }
    return [and(...conditions) ?? eq(unitsOfMeasure.isActive, true)];
  },
  toOption: optionOf,
});

const kinds = staticSource({
  key: 'unit-kinds',
  permission: 'units:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return UNIT_KINDS.map((k) => ({ id: k.id, label: k.label, description: k.hint }));
  },
});

/**
 * The units one product can be quoted, sold or counted in: its base unit and its alternate units, each with how many
 * base units it holds. The `product` filter names the product. At most the product's own few units, so one read.
 */
const productUnitList = staticSource({
  key: 'product-units',
  permission: 'products:read',
  items: async ({ filters }) => {
    const { product, ...rest } = filters;
    if (
      Object.keys(rest).length > 0 ||
      product === undefined ||
      product === '' ||
      product.length > 100
    ) {
      throw new LookupFilterError('Choose the product first.');
    }
    const repo = getContainer().units;
    const row = await getContainer().catalog.getProductById(product);
    if (row === null) throw new LookupFilterError('That product does not exist.');
    const [base] = await repo.getByIds([row.baseUnitId]);
    const alternates = await repo.packagingOf(product);
    const options = alternates.map((p) => ({
      id: p.unitId,
      label: `${p.unitCode} · ${p.unitName}`,
      description:
        `1 ${p.unitCode} = ${trimmedDecimal(parseDecimal(p.qtyPerBase) ?? 0n)} ${base?.code ?? ''}`.trim(),
      meta: { code: p.unitCode, qtyPerUnit: trimmedDecimal(parseDecimal(p.qtyPerBase) ?? 0n) },
    }));
    return base === undefined
      ? options
      : [
          {
            id: base.id,
            label: `${base.code} · ${base.name}`,
            description: 'The unit stock is counted in',
            meta: { code: base.code, qtyPerUnit: '1' },
          },
          ...options,
        ];
  },
});

export const UNIT_LOOKUP_SOURCES: LookupSource[] = [units, kinds, productUnitList];
