/** Seller-configured fit of one packaging product for one order product. */
export interface PackagingFit {
  productId: string;
  packagingProductId: string;
  /** Maximum quantity of this product that safely fits in one package, in its base unit. */
  capacity: number;
}

export interface PackagingSuggestionLine {
  productId: string;
  quantity: number;
}

export interface PackagingSuggestion {
  packagingProductId: string;
  /** Sum of separately rounded package requirements across eligible cart lines. */
  quantity: number;
  eligibleProductIds: string[];
  uncoveredProductIds: string[];
}

export interface SelectedPackagingLine {
  productId: string;
  quantity: number;
}

export interface PackagingSelectionProblem {
  code: 'invalid_input' | 'invalid_quantity';
  message: string;
}

/**
 * Computes package counts from explicit seller-maintained fit rules. Cart lines are
 * rounded independently: quantities in different product units are never combined
 * or treated as interchangeable capacity. Missing/invalid fit data produces no
 * suggestion for that product, rather than a potentially unsafe guess.
 */
export function suggestPackaging(
  lines: readonly PackagingSuggestionLine[],
  fits: readonly PackagingFit[],
): PackagingSuggestion[] {
  const byPackage = new Map<string, Map<string, number>>();
  for (const fit of fits) {
    if (
      fit.productId === '' ||
      fit.packagingProductId === '' ||
      !Number.isFinite(fit.capacity) ||
      fit.capacity <= 0
    )
      continue;
    const byProduct = byPackage.get(fit.packagingProductId) ?? new Map<string, number>();
    // Duplicate configuration is treated conservatively: use the smallest capacity.
    const existing = byProduct.get(fit.productId);
    byProduct.set(
      fit.productId,
      existing === undefined ? fit.capacity : Math.min(existing, fit.capacity),
    );
    byPackage.set(fit.packagingProductId, byProduct);
  }

  const result: PackagingSuggestion[] = [];
  for (const [packagingProductId, capacities] of byPackage) {
    let quantity = 0;
    const eligibleProductIds: string[] = [];
    const uncoveredProductIds: string[] = [];
    for (const line of lines) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) continue;
      const capacity = capacities.get(line.productId);
      if (capacity === undefined) continue;
      eligibleProductIds.push(line.productId);
      quantity += Math.ceil(line.quantity / capacity);
    }
    if (quantity > 0)
      result.push({ packagingProductId, quantity, eligibleProductIds, uncoveredProductIds });
  }

  // Expose items with no configured packaging fit so the UI can explain why no
  // quantity was auto-suggested instead of silently implying they are covered.
  const configuredProductIds = new Set(
    fits
      .filter((fit) => Number.isFinite(fit.capacity) && fit.capacity > 0)
      .map((fit) => fit.productId),
  );
  const uncovered = lines
    .filter(
      (line) =>
        Number.isFinite(line.quantity) &&
        line.quantity > 0 &&
        !configuredProductIds.has(line.productId),
    )
    .map((line) => line.productId);
  if (uncovered.length > 0) {
    for (const suggestion of result) suggestion.uncoveredProductIds = uncovered;
  }
  return result;
}

/** Server-side checkout invariant for explicitly selected packaging. */
export function packagingSelectionProblem(
  goods: readonly PackagingSuggestionLine[],
  selected: readonly SelectedPackagingLine[],
  fits: readonly PackagingFit[],
): PackagingSelectionProblem | null {
  if (selected.some((line) => !Number.isInteger(line.quantity) || line.quantity <= 0)) {
    return { code: 'invalid_quantity', message: 'Packaging quantities must be whole packages.' };
  }
  const needed = new Map(
    suggestPackaging(goods, fits).map((line) => [line.packagingProductId, line.quantity]),
  );
  for (const line of selected) {
    const required = needed.get(line.productId);
    if (required === undefined) {
      return {
        code: 'invalid_input',
        message: 'One of the selected packaging options does not fit your order.',
      };
    }
    if (line.quantity < required) {
      return {
        code: 'invalid_quantity',
        message:
          'Please add the suggested quantity of packaging so your order can be packed safely.',
      };
    }
  }
  return null;
}
