import type { ProductSpecification } from '@/types/index';

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
