/** A refusal the person is told in words (a rule, a missing record, an out-of-date screen). */
export class VanSalesError extends Error {}

/** The name of the constraint a database error broke, however deep the driver wrapped it. */
export function constraintOf(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; typeof e === 'object' && e !== null && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const named = e as { constraint?: unknown; constraint_name?: unknown };
    if (typeof named.constraint === 'string') return named.constraint;
    if (typeof named.constraint_name === 'string') return named.constraint_name;
  }
  return null;
}
