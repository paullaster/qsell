'use server';

import { getContainer } from '@/server/di/container';
import { runSetting, SettingsError } from '@/server/domains/settings/action-runner';
import {
  NO_USAGE,
  draftFromUnit,
  isUnitKind,
  unitKindLabel,
  usageWords,
  isUsed,
  type UnitDraft,
  type UnitUsage,
} from '@/lib/unit-rules';
import type { UnitOfMeasureRow } from '@/server/db/drizzle/schema';
import { unitNotFound } from './errors';
import { fieldsOf, unitConflictWords } from './write-service';
import type { UnitPageInput } from './repository';
import type { ProductPackagingInput } from '@/types/index';

const ROOT = '/admin/settings/units';
const PATHS = [ROOT, '/admin/products'];

export interface UnitView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  symbol: string | null;
  kind: string;
  kindLabel: string;
  baseUnitId: string | null;
  baseUnitCode: string | null;
  factorToBase: string;
  decimals: number;
  internationalCode: string | null;
  etimsCode: string | null;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  usage: UnitUsage;
  /** Where it is used, in words; null when nowhere (and so it can be deleted). */
  usageWords: string | null;
  canDelete: boolean;
}

function toView(row: UnitOfMeasureRow, baseCode: string | null, usage: UnitUsage): UnitView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    symbol: row.symbol,
    kind: row.kind,
    kindLabel: unitKindLabel(row.kind),
    baseUnitId: row.baseUnitId,
    baseUnitCode: baseCode,
    factorToBase: row.factorToBase.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''),
    decimals: row.decimals,
    internationalCode: row.internationalCode,
    etimsCode: row.etimsCode,
    isDefault: row.isDefault,
    isActive: row.isActive,
    version: row.version,
    usage,
    usageWords: usageWords(usage),
    canDelete: !row.isDefault && !isUsed(usage),
  };
}

/** The rows as views, with their base unit's code and their usage, each read for the whole page at once. */
async function viewsOf(rows: UnitOfMeasureRow[]): Promise<UnitView[]> {
  const repo = getContainer().units;
  const baseIds = [...new Set(rows.flatMap((r) => (r.baseUnitId === null ? [] : [r.baseUnitId])))];
  const [bases, usage] = await Promise.all([
    repo.getByIds(baseIds),
    repo.usageOf(rows.map((r) => r.id)),
  ]);
  const codes = new Map(bases.map((b) => [b.id, b.code]));
  return rows.map((r) =>
    toView(
      r,
      r.baseUnitId === null ? null : (codes.get(r.baseUnitId) ?? null),
      usage[r.id] ?? NO_USAGE,
    ),
  );
}

/** One page of units in code order, narrowed by text, kind and state. */
export async function unitsPageAction(input: UnitPageInput) {
  return runSetting('units:read', async () => {
    const kind = input.kind !== undefined && isUnitKind(input.kind) ? input.kind : undefined;
    const status =
      input.status === 'active' || input.status === 'inactive' ? input.status : undefined;
    const page = await getContainer().units.page({
      query: input.query,
      cursor: input.cursor,
      kind,
      status,
    });
    return { rows: await viewsOf(page.rows), nextCursor: page.nextCursor };
  });
}

export async function getUnitAction(id: string) {
  return runSetting('units:read', async () => {
    const row = await getContainer().units.getById(id);
    if (row === null) throw unitNotFound();
    return (await viewsOf([row]))[0];
  });
}

export async function createUnitAction(draft: UnitDraft) {
  return runSetting(
    'units:manage',
    async () => {
      const row = await getContainer().unitWriter.create(draft);
      return (await viewsOf([row]))[0];
    },
    { paths: PATHS, friendly: unitConflictWords },
  );
}

export async function updateUnitAction(
  id: string,
  version: number,
  draft: UnitDraft,
  isActive?: boolean,
) {
  return runSetting(
    'units:manage',
    async () => {
      const row = await getContainer().unitWriter.update(id, version, draft, isActive);
      return (await viewsOf([row]))[0];
    },
    { paths: PATHS, friendly: unitConflictWords },
  );
}

/** Switches a unit on or off without touching anything else about it. */
export async function setUnitActiveAction(id: string, version: number, isActive: boolean) {
  return runSetting(
    'units:manage',
    async () => {
      const current = await getContainer().units.getById(id);
      if (current === null) throw unitNotFound();
      const row = await getContainer().unitWriter.update(
        id,
        version,
        draftFromUnit(fieldsOf(current)),
        isActive,
      );
      return (await viewsOf([row]))[0];
    },
    { paths: PATHS, friendly: unitConflictWords },
  );
}

export async function makeDefaultUnitAction(id: string) {
  return runSetting(
    'units:manage',
    async () => {
      const row = await getContainer().unitWriter.makeDefault(id);
      return (await viewsOf([row]))[0];
    },
    { paths: PATHS, friendly: unitConflictWords },
  );
}

export async function deleteUnitAction(id: string) {
  return runSetting(
    'units:manage',
    async () => {
      await getContainer().unitWriter.remove(id);
    },
    { paths: PATHS, friendly: unitConflictWords },
  );
}

export interface ProductUnitsView {
  baseUnit: { id: string; code: string; name: string; decimals: number };
  packagings: {
    unitId: string;
    unitCode: string;
    unitName: string;
    qtyPerBase: string;
    weightKg: string | null;
    isSalesDefault: boolean;
    isPurchaseDefault: boolean;
  }[];
}

const plain = (n: string): string => n.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/** A product's base unit and the other units it is kept, bought or sold in. */
export async function productUnitsAction(productId: string) {
  return runSetting('products:read', async (): Promise<ProductUnitsView> => {
    const c = getContainer();
    const product = await c.catalog.getProductById(productId);
    if (product === null) throw new SettingsError('That product does not exist.', 'NOT_FOUND');
    const [base] = await c.units.getByIds([product.baseUnitId]);
    if (base === undefined) throw unitNotFound();
    const packagings = await c.units.packagingOf(productId);
    return {
      baseUnit: { id: base.id, code: base.code, name: base.name, decimals: base.decimals },
      packagings: packagings.map((p) => ({
        unitId: p.unitId,
        unitCode: p.unitCode,
        unitName: p.unitName,
        qtyPerBase: plain(p.qtyPerBase),
        weightKg: p.weightKg === null ? null : plain(p.weightKg),
        isSalesDefault: p.isSalesDefault,
        isPurchaseDefault: p.isPurchaseDefault,
      })),
    };
  });
}

/**
 * Checks a product's unit choices without saving anything, so the form can show a rule failure in words
 * before the product is saved (the product save checks again on its own).
 */
export async function checkProductUnitsAction(input: {
  productId: string | null;
  baseUnitId: string;
  packagings: ProductPackagingInput[];
}) {
  return runSetting('products:read', async () => {
    const c = getContainer();
    const product =
      input.productId === null ? null : await c.catalog.getProductById(input.productId);
    if (input.productId !== null && product === null)
      throw new SettingsError('That product does not exist.', 'NOT_FOUND');
    await c.unitWriter.planForProduct({
      productId: input.productId,
      requestedUnitId: input.baseUnitId,
      current: product,
      packagings: input.packagings,
    });
    return true;
  });
}
