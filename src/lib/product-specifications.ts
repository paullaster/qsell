import type { ProductSpecification } from '@/types/index';
import { isRecord } from '@/lib/values';

export const MAX_PRODUCT_SPECIFICATIONS = 100;
export const PRODUCT_SPECIFICATION_KEY_MAX_LENGTH = 160;
export const PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH = 2000;

/** Server-side validation for the product editor's JSON specification rows. */
export function productSpecificationsProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'Product specifications must be a list.';
  if (value.length > MAX_PRODUCT_SPECIFICATIONS) {
    return `A product can have at most ${String(MAX_PRODUCT_SPECIFICATIONS)} specifications.`;
  }
  for (const [index, row] of value.entries()) {
    if (!isRecord(row) || typeof row.key !== 'string' || typeof row.value !== 'string') {
      return `Specification ${String(index + 1)} is not valid.`;
    }
    const key = row.key.trim();
    const specificationValue = row.value.trim();
    if (key === '' || specificationValue === '') {
      return `Enter both a name and value for specification ${String(index + 1)}, or remove the row.`;
    }
    if (key.length > PRODUCT_SPECIFICATION_KEY_MAX_LENGTH) {
      return `Specification ${String(index + 1)} name must be ${String(PRODUCT_SPECIFICATION_KEY_MAX_LENGTH)} characters or fewer.`;
    }
    if (specificationValue.length > PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH) {
      return `Specification ${String(index + 1)} value must be ${String(PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH)} characters or fewer.`;
    }
  }
  return null;
}

/** The specifications worth showing a shopper: a row needs both a name and a value, and its words are trimmed. */
export function visibleSpecifications(
  specifications: readonly ProductSpecification[] | undefined,
): ProductSpecification[] {
  return (specifications ?? []).flatMap((spec) => {
    const key = spec.key.trim();
    const value = spec.value.trim();
    return key === '' || value === '' ? [] : [{ key, value }];
  });
}
