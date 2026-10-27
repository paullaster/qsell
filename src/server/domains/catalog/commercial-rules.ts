/** What a person typed for an optional amount: nothing means "none"; anything else is a number, which may turn out not to be one. */
export function optionalAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'number' ? value : Number(value);
}

/** Why a standard price cannot be saved, in words; null when it can (or when there is none, which means "the selling price"). */
export function standardPriceProblem(value: number | null, sellable: boolean): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) return 'The standard price must be 0 or more. Leave it empty to use the selling price.';
  if (sellable && value <= 0) return 'The standard price of an item for sale must be above zero. Leave it empty to use the selling price.';
  return null;
}
