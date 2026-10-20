import { quantityFits, roundQty } from '@/lib/decimal';
import { lineInBase, quantityProblem, type Checked } from '@/lib/unit-rules';
import { has } from '@/lib/values';

/**
 * Credit notes and returns in the unit the goods were sold in. A document never depends on the product's
 * live units: the unit and its conversion are the ones kept on the order line, so a unit the product has
 * since dropped can still be credited. Pure.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The unit an order line was entered in, as kept on that line. */
export interface SoldUnit {
  id: string;
  code: string;
  /** Base units in one of this unit, as exact text. */
  qtyPerUnit: string;
}

/** One order line, as read for crediting. */
export interface SoldItem {
  productId: string;
  description: string;
  /** In base units. */
  quantity: number;
  unitPrice: number;
  amount: number;
  /** The unit the line was entered in; absent or null when it was sold in the base unit. */
  unit?: SoldUnit | null;
  /** Decimals the product's base unit allows (3 when not known). */
  baseDecimals?: number;
  baseUnitId?: string;
  baseUnitName?: string;
}

/** One product on the invoice: every line of it added up, with the unit when all its lines share one. */
export interface SoldProduct extends SoldItem {
  /** Lines of the product that were merged into this one. */
  lines: number;
}

const unitOf = (s: SoldItem): SoldUnit | null => s.unit ?? null;

/**
 * The invoice per product. The same product can be on an order twice (sold by the kg and by the crate), and
 * credit is tracked per product, so the lines are added up; the unit is kept only when they all share it.
 * The price per unit is the average, and the final credit takes whatever is left, so cents never go missing.
 */
export function soldByProduct(items: readonly SoldItem[]): SoldProduct[] {
  const byProduct = new Map<string, SoldItem[]>();
  for (const item of items)
    byProduct.set(item.productId, [...(byProduct.get(item.productId) ?? []), item]);
  return [...byProduct.values()].map((group) => {
    const [first] = group;
    if (group.length === 1) return { ...first, lines: 1 };
    const quantity = roundQty(group.reduce((n, g) => n + g.quantity, 0));
    const amount = round2(group.reduce((n, g) => n + g.amount, 0));
    const sameUnit = group.every(
      (g) =>
        unitOf(g)?.id === unitOf(first)?.id && unitOf(g)?.qtyPerUnit === unitOf(first)?.qtyPerUnit,
    );
    return {
      ...first,
      quantity,
      amount,
      unitPrice: quantity > 0 ? round2(amount / quantity) : first.unitPrice,
      unit: sameUnit ? unitOf(first) : null,
      lines: group.length,
    };
  });
}

/** What was asked for on one line of a credit. */
export interface CreditAsk {
  productId: string;
  quantity: number;
  /** The unit `quantity` is in; absent means the base unit. Only the unit the goods were sold in is accepted. */
  unitId?: string | null;
}

export interface CreditQuantity {
  /** In base units: what stock, the invoice and the limits work in. */
  base: number;
  /** Set when the credit was given in the unit the goods were sold in. */
  unit: SoldUnit | null;
  entered: number | null;
}

/** The credit in base units, refusing a unit the goods were not sold in and a quantity the unit cannot hold. */
export function creditInBase(sold: SoldProduct, ask: CreditAsk): Checked<CreditQuantity> {
  const unit = unitOf(sold);
  const baseName = sold.baseUnitName ?? 'the base unit';
  const inBase = !has(ask.unitId) || ask.unitId === sold.baseUnitId;
  if (inBase) {
    const problem = quantityProblem(
      ask.quantity,
      sold.baseDecimals ?? 3,
      baseName,
      `Quantity of "${sold.description}"`,
    );
    return problem === null
      ? { ok: true, value: { base: ask.quantity, unit: null, entered: null } }
      : { ok: false, error: problem };
  }
  if (unit === null || ask.unitId !== unit.id)
    return {
      ok: false,
      error:
        unit === null
          ? `"${sold.description}" was not sold in another unit. Credit it in ${baseName}.`
          : `"${sold.description}" was sold in ${unit.code}. Credit it in ${unit.code} or in ${baseName}.`,
    };
  if (!quantityFits(ask.quantity, 3))
    return { ok: false, error: `Quantity of "${sold.description}" can have at most 3 decimals.` };
  const base = lineInBase(ask.quantity, unit.qtyPerUnit, sold.baseDecimals ?? 3);
  if (!base.ok) return { ok: false, error: `"${sold.description}": ${base.error}` };
  return { ok: true, value: { base: base.value, unit, entered: ask.quantity } };
}

/** A quantity of base units written in the unit it was sold in ("2 crate"), or plainly when it has no unit. */
export function creditWords(
  base: number,
  unit: Pick<SoldUnit, 'code' | 'qtyPerUnit'> | null,
): string {
  if (unit === null) return String(base);
  const per = Number(unit.qtyPerUnit);
  const entered = per > 0 ? roundQty(base / per) : base;
  return `${String(entered)} ${unit.code}`;
}
