/** Pairs each item with a key that is the same on every draw and different for every item, even when `base` repeats. */
export function keyed<T>(items: readonly T[], base: (item: T) => string): { item: T; key: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const name = base(item);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return { item, key: `${name}#${String(n)}` };
  });
}
