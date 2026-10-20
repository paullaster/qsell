import { has } from '@/lib/values';
import { parseDecimal } from '@/lib/decimal';
import {
  lineInBase,
  changesMeaning,
  checkUnit,
  isUsed,
  usageWords,
  checkPackagings,
  quantityProblem,
  trimmedDecimal,
  type PackagingDraft,
  type UnitDraft,
  type UnitFields,
} from '@/lib/unit-rules';
import type { UnitOfMeasureRow } from '@/server/db/drizzle/schema';
import { isForeignKeyViolation, isUniqueViolation } from '@/server/domains/settings/errors';
import { UnitError, unitChangedByOther, unitNotFound } from './errors';
import type { PackagingRow, UnitRepository } from './repository';

/** The words to show for a database refusal of a unit, or null when it is some other failure. */
export function unitConflictWords(error: unknown): string | null {
  if (isUniqueViolation(error)) return 'A unit with that code or name already exists.';
  if (isForeignKeyViolation(error))
    return 'That unit is used by products or other units, so it cannot be removed. Switch it off instead.';
  return null;
}

/** Runs a write and turns the database's refusal of a duplicate or a still-referenced unit into words for the person. */
async function words<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const said = unitConflictWords(error);
    if (said !== null) throw new UnitError(said, 'CONFLICT');
    throw error;
  }
}

/** What a document line needs to know of its product to be counted in a unit. */
export interface LineProduct {
  id: string;
  name: string;
  baseUnitId: string;
  baseUnitCode: string;
  baseUnitName: string;
  baseUnitDecimals: number;
}

export interface LineUnitIn {
  productId: string;
  /** In the line's own unit. */
  quantity: number;
  unitId?: string | null;
  /** Per one of the line's own unit. */
  unitPrice?: number | null;
}

export interface LineUnitOut {
  /** In the product's base unit. */
  quantity: number;
  /** Per base unit (the typed price converted), for the pricing engine. */
  unitPrice: number | undefined;
  unitId: string;
  unitCode: string;
  /** Null when the line was typed in the base unit. */
  enteredQuantity: number | null;
  qtyPerUnit: string | null;
  enteredUnitPrice: number | null;
}

export const fieldsOf = (row: UnitOfMeasureRow): UnitFields => ({
  code: row.code,
  name: row.name,
  description: row.description,
  symbol: row.symbol,
  kind: row.kind as UnitFields['kind'],
  baseUnitId: row.baseUnitId,
  factorToBase: row.factorToBase,
  decimals: row.decimals,
  internationalCode: row.internationalCode,
  etimsCode: row.etimsCode,
});

/**
 * Every change to a unit of measure goes through here. The rules that keep quantities meaningful live
 * in one place: a unit in use keeps what it means (family, base, factor) and never loses decimals,
 * a unit that others convert from cannot be removed, and the default unit is always on.
 */
export class UnitWriteService {
  constructor(private readonly repo: UnitRepository) {}

  /** The unit a derived unit would be a multiple of, which must be an active base unit of the same family. */
  private async checkBase(fields: UnitFields, selfId: string | null): Promise<void> {
    if (fields.baseUnitId === null) return;
    if (fields.baseUnitId === selfId) throw new UnitError('A unit cannot be a multiple of itself.');
    const base = await this.repo.getById(fields.baseUnitId);
    if (base === null) throw new UnitError('The base unit does not exist.');
    if (base.kind !== fields.kind)
      throw new UnitError('A unit and its base unit must be of the same kind.');
    if (base.baseUnitId !== null)
      throw new UnitError(
        'Choose the base of the family (for example kilogram), not another multiple of it.',
      );
    if (!base.isActive) throw new UnitError('The base unit is switched off.');
  }

  async create(draft: UnitDraft): Promise<UnitOfMeasureRow> {
    const checked = checkUnit(draft);
    if (!checked.ok) throw new UnitError(checked.error);
    await this.checkBase(checked.value, null);
    return await words(() =>
      this.repo.insert({ ...checked.value, isDefault: false, isActive: true }),
    );
  }

  async update(
    id: string,
    version: number,
    draft: UnitDraft,
    isActive: boolean | undefined,
  ): Promise<UnitOfMeasureRow> {
    const existing = await this.repo.getById(id);
    if (existing === null) throw unitNotFound();
    if (existing.version !== version) throw unitChangedByOther();
    const checked = checkUnit(draft);
    if (!checked.ok) throw new UnitError(checked.error);
    const next = checked.value;
    const before = fieldsOf(existing);
    const active = isActive ?? existing.isActive;

    if (existing.isDefault && !active)
      throw new UnitError('The default unit must stay on. Make another unit the default first.');
    const usage = (await this.repo.usageOf([id]))[id];
    if (usage !== undefined && isUsed(usage)) {
      if (changesMeaning(before, next)) {
        throw new UnitError(
          `${usageWords(usage) ?? 'This unit'}, so its kind, base unit and conversion factor can no longer change: stored quantities would change meaning. Create a new unit instead.`,
        );
      }
      if (next.decimals < before.decimals)
        throw new UnitError(
          'Decimals cannot be lowered once the unit is in use: saved quantities could no longer be shown exactly.',
        );
    }
    await this.checkBase(next, id);
    const row = await words(() => this.repo.update(id, version, { ...next, isActive: active }));
    if (row === null) throw unitChangedByOther();
    return row;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repo.getById(id);
    if (existing === null) throw unitNotFound();
    if (existing.isDefault)
      throw new UnitError(
        'The default unit cannot be deleted. Make another unit the default first.',
      );
    const usage = (await this.repo.usageOf([id]))[id];
    if (usage !== undefined && isUsed(usage)) {
      throw new UnitError(
        `${usageWords(usage) ?? 'This unit is in use'}, so it cannot be deleted. Switch it off to stop new use, or replace it on those records first.`,
      );
    }
    // The database refuses too (restrict keys), which covers a product that picked this unit a moment ago.
    if (!(await words(() => this.repo.delete(id)))) throw unitNotFound();
  }

  async makeDefault(id: string): Promise<UnitOfMeasureRow> {
    const existing = await this.repo.getById(id);
    if (existing === null) throw unitNotFound();
    if (!existing.isActive) throw new UnitError('Switch the unit on before making it the default.');
    const row = await this.repo.makeDefault(id);
    if (row === null) throw unitNotFound();
    return row;
  }

  /** The unit a product is counted in: the one asked for (which must exist and be on), else the default. */
  async resolveBaseUnit(requested: string | null | undefined): Promise<UnitOfMeasureRow> {
    if (has(requested)) {
      const row = await this.repo.getById(requested);
      if (row?.isActive !== true)
        throw new UnitError('Choose a unit of measure that exists and is switched on.');
      return row;
    }
    const fallback = await this.repo.getDefault();
    if (fallback === null) throw new UnitError('Set up a default unit of measure first.');
    return fallback;
  }

  /** A product's alternate units checked and ready to save: each unit must exist and be on. */
  async preparePackaging(
    baseUnitId: string,
    drafts: readonly PackagingDraft[],
  ): Promise<PackagingRow[]> {
    const checked = checkPackagings(drafts, baseUnitId);
    if (!checked.ok) throw new UnitError(checked.error);
    const units = await this.repo.getByIds(checked.value.map((r) => r.unitId));
    const known = new Map(units.map((u) => [u.id, u]));
    for (const row of checked.value) {
      const unit = known.get(row.unitId);
      if (unit?.isActive !== true)
        throw new UnitError('Every alternate unit must exist and be switched on.');
    }
    return checked.value.map((r) => ({
      unitId: r.unitId,
      qtyPerBase: r.qtyPerBase,
      weightKg: r.weightKg,
      isSalesDefault: r.isSalesDefault,
      isPurchaseDefault: r.isPurchaseDefault,
    }));
  }

  /** Whether the base unit may be changed: not once quantities have been recorded in it. */
  async assertBaseUnitChangeable(
    productId: string,
    stockQuantity: number,
    reservedQuantity: number,
  ): Promise<void> {
    if (
      stockQuantity !== 0 ||
      reservedQuantity !== 0 ||
      (await this.repo.hasQuantityHistory(productId))
    ) {
      throw new UnitError(
        'This product already has stock or history counted in its current unit, so the unit cannot be changed. Create a new product for the new unit.',
      );
    }
  }

  /**
   * Everything a product save needs to know about its units, decided in one place for create and update:
   * the base unit (asked for, else the current one, else the default), whether a change of it is allowed,
   * and the alternate units checked and ready to save (undefined when the save leaves them alone).
   */
  async planForProduct(input: {
    productId: string | null;
    requestedUnitId: string | null | undefined;
    current: { baseUnitId: string; stockQuantity: number; reservedQuantity: number } | null;
    packagings: readonly PackagingDraft[] | undefined;
  }): Promise<{ unit: UnitOfMeasureRow; packagings: PackagingRow[] | undefined }> {
    const { productId, current } = input;
    const unit = await this.resolveBaseUnit(input.requestedUnitId ?? current?.baseUnitId);
    if (productId !== null && current !== null && unit.id !== current.baseUnitId) {
      await this.assertBaseUnitChangeable(
        productId,
        current.stockQuantity,
        current.reservedQuantity,
      );
      if (input.packagings === undefined && (await this.hasPackaging(productId))) {
        throw new UnitError(
          'This product has alternate units set against its current unit. Re-enter them for the new unit when you change it.',
        );
      }
    }
    const packagings =
      input.packagings === undefined
        ? undefined
        : await this.preparePackaging(unit.id, input.packagings);
    return { unit, packagings };
  }

  /**
   * Turns the lines of a quote or order, each typed in a unit of its product, into base units. A line without a
   * unit (or in the base unit) is left as it is. A unit the product is not sold in is refused with its name. All
   * the products' alternate units are read in one query.
   */
  async convertLines(
    products: ReadonlyMap<string, LineProduct>,
    lines: readonly LineUnitIn[],
  ): Promise<LineUnitOut[]> {
    const wanted = [
      ...new Set(
        lines
          .filter((l) => has(l.unitId) && products.get(l.productId)?.baseUnitId !== l.unitId)
          .map((l) => l.productId),
      ),
    ];
    const packagings = await this.repo.packagingForProducts(wanted);
    const byKey = new Map(packagings.map((p) => [`${p.productId}:${p.unitId}`, p]));
    return lines.map((line) => {
      const product = products.get(line.productId);
      if (product === undefined)
        throw new UnitError('A line names a product that no longer exists.');
      const decimals = product.baseUnitDecimals;
      if (!has(line.unitId) || line.unitId === product.baseUnitId) {
        const problem = quantityProblem(
          line.quantity,
          decimals,
          product.baseUnitName,
          `Quantity of "${product.name}"`,
        );
        if (problem !== null) throw new UnitError(problem);
        return {
          quantity: line.quantity,
          unitPrice: line.unitPrice ?? undefined,
          unitId: product.baseUnitId,
          unitCode: product.baseUnitCode,
          enteredQuantity: null,
          qtyPerUnit: null,
          enteredUnitPrice: null,
        };
      }
      const alternate = byKey.get(`${line.productId}:${line.unitId}`);
      if (alternate === undefined)
        throw new UnitError(
          `"${product.name}" is not sold in that unit. Choose one of its own units.`,
        );
      // A quantity still being typed (zero) is let through here; saving refuses it before it gets this far.
      const base =
        line.quantity === 0
          ? { ok: true as const, value: 0 }
          : lineInBase(line.quantity, alternate.qtyPerBase, decimals);
      if (!base.ok) throw new UnitError(`"${product.name}": ${base.error}`);
      const perUnit = Number(alternate.qtyPerBase);
      const typed = line.unitPrice ?? null;
      return {
        quantity: base.value,
        unitPrice: typed === null ? undefined : Math.round((typed / perUnit) * 1e4) / 1e4,
        unitId: alternate.unitId,
        unitCode: alternate.unitCode,
        enteredQuantity: line.quantity,
        qtyPerUnit: trimmedDecimal(parseDecimal(alternate.qtyPerBase) ?? 0n),
        enteredUnitPrice: typed,
      };
    });
  }

  /**
   * How many base units one of each line's unit holds (1 for a line in the base unit), for the screens that only
   * need the conversion: a price shown per crate is the price per kg times this. Read in one query.
   */
  async lineFactors(
    lines: readonly { productId: string; unitId?: string | null }[],
    baseUnitOf: (productId: string) => string | undefined,
  ): Promise<number[]> {
    const wanted = [
      ...new Set(
        lines
          .filter((l) => has(l.unitId) && baseUnitOf(l.productId) !== l.unitId)
          .map((l) => l.productId),
      ),
    ];
    const byKey = new Map(
      (await this.repo.packagingForProducts(wanted)).map((p) => [
        `${p.productId}:${p.unitId}`,
        Number(p.qtyPerBase),
      ]),
    );
    return lines.map((l) => {
      if (!has(l.unitId) || baseUnitOf(l.productId) === l.unitId) return 1;
      const factor = byKey.get(`${l.productId}:${l.unitId}`);
      if (factor === undefined)
        throw new UnitError('A line uses a unit its product is not sold in.');
      return factor;
    });
  }

  /** True when the product has alternate units, which are defined against its current base unit. */
  async hasPackaging(productId: string): Promise<boolean> {
    return (await this.repo.packagingOf(productId)).length > 0;
  }
}
