'use client';

import type { DiscountLookups } from '@/server/domains/pricing/discount-actions';
import type { DiscountTarget } from '@/server/domains/pricing/domain/discounts';
import { labelClass } from '../approvals/shared';
import { ProductPick } from './PriceLinesPanel';

/** A product selector as the form holds it: named products carry their label for display. */
export interface TargetState {
  all: boolean;
  categoryIds: string[];
  brands: string[];
  productGroupIds: string[];
  products: { id: string; label: string }[];
}

export const everything = (): TargetState => ({
  all: true,
  categoryIds: [],
  brands: [],
  productGroupIds: [],
  products: [],
});

export function targetToState(
  t: DiscountTarget | undefined,
  names: Record<string, string> = {},
): TargetState {
  const none =
    !t ||
    ((t.categoryIds?.length ?? 0) === 0 &&
      (t.brands?.length ?? 0) === 0 &&
      (t.productGroupIds?.length ?? 0) === 0 &&
      (t.productIds?.length ?? 0) === 0);
  return {
    all: !t || t.all === true || none,
    categoryIds: t?.categoryIds ?? [],
    brands: t?.brands ?? [],
    productGroupIds: t?.productGroupIds ?? [],
    products: (t?.productIds ?? []).map((id) => ({ id, label: names[id] ?? id })),
  };
}

export const stateToTarget = (s: TargetState): DiscountTarget =>
  s.all
    ? { all: true }
    : {
        categoryIds: s.categoryIds,
        brands: s.brands,
        productGroupIds: s.productGroupIds,
        productIds: s.products.map((p) => p.id),
      };

/**
 * Chooses which products something applies to: all of them, or those in chosen categories (with
 * their sub-categories), brands, product groups, or named one by one.
 */
export function TargetEditor({
  value,
  onChange,
  lookups,
  everythingLabel = 'Every product',
}: {
  value: TargetState;
  onChange: (next: TargetState) => void;
  lookups: DiscountLookups;
  everythingLabel?: string;
}) {
  const set = <K extends keyof TargetState>(k: K, v: TargetState[K]) =>
    onChange({ ...value, [k]: v });
  return (
    <div className="space-y-3">
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={value.all}
          onChange={(e) => set('all', e.target.checked)}
        />
        {everythingLabel}
      </label>
      {!value.all ? (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <p className="text-xs text-fg-muted">A product qualifies if it matches any of these.</p>
          <Multi
            legend="Categories (a category includes its sub-categories)"
            options={lookups.categories.map((c) => ({
              value: c.id,
              label: `${'— '.repeat(c.depth)}${c.name}`,
            }))}
            selected={value.categoryIds}
            onChange={(v) => set('categoryIds', v)}
            empty="No categories."
          />
          <Multi
            legend="Brands"
            options={lookups.brands.map((b) => ({ value: b, label: b }))}
            selected={value.brands}
            onChange={(v) => set('brands', v)}
            empty="No brands on any product yet."
          />
          <Multi
            legend="Product groups"
            options={lookups.productGroups.map((g) => ({
              value: g.id,
              label: `${g.name} (${g.code})`,
            }))}
            selected={value.productGroupIds}
            onChange={(v) => set('productGroupIds', v)}
            empty="No product groups. Make one under Product groups to cover many products at once."
          />
          <div>
            <p className={labelClass}>Single products (up to 200)</p>
            <div className="mb-2 flex flex-wrap gap-2">
              {value.products.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken px-2 py-1 text-xs"
                >
                  {p.label}
                  <button
                    type="button"
                    aria-label={`Remove ${p.label}`}
                    className="min-h-8 min-w-8 cursor-pointer font-bold"
                    onClick={() =>
                      set(
                        'products',
                        value.products.filter((x) => x.id !== p.id),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <ProductPick
              value=""
              onPick={(p) =>
                value.products.some((x) => x.id === p.id)
                  ? undefined
                  : set('products', [
                      ...value.products,
                      { id: p.id, label: `${p.name} (${p.sku})` },
                    ])
              }
              onClear={() => undefined}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Multi({
  legend,
  options,
  selected,
  onChange,
  empty,
}: {
  legend: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  empty: string;
}) {
  if (options.length === 0) return empty ? <p className="text-xs text-fg-muted">{empty}</p> : null;
  return (
    <fieldset>
      <legend className={labelClass}>{legend}</legend>
      <div className="grid max-h-56 grid-cols-1 gap-1 overflow-auto sm:grid-cols-2">
        {options.map((o) => (
          <label key={o.value} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 shrink-0"
              checked={selected.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value),
                )
              }
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
