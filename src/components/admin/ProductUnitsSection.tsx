'use client';

import { useEffect, useId, useState } from 'react';
import { productUnitsAction } from '@/server/domains/units/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { buttonClass, fieldClass } from '@/components/ui/screen-kit';
import { MAX_PACKAGINGS } from '@/lib/unit-rules';
import type { Choice } from '@/lib/payment-options';
import type { ProductPackagingInput } from '@/types/index';

/** One alternate-unit row as the form holds it: the unit's words next to what is sent. */
export interface PackagingRowState extends ProductPackagingInput {
  /** Keeps a row's own field values with it when another row is removed; never sent. */
  key: string;
  unitLabel: string;
}

export const newPackagingRow = (): PackagingRowState => ({
  key: crypto.randomUUID(),
  unitId: '',
  unitLabel: '',
  qtyPerBase: '',
  weightKg: '',
  isSalesDefault: false,
  isPurchaseDefault: false,
});

/**
 * The unit a product is counted in, and the other units it is kept, bought or sold in ("1 CRATE = 20 KG").
 * Everything is picked from the shared list of units; nothing here decides what a unit means.
 */
export function ProductUnitsSection({
  productId,
  base,
  onBase,
  rows,
  onRows,
}: {
  /** The product being edited; null while making a new one (nothing to load). */
  productId: string | null;
  base: Choice | null;
  onBase: (choice: Choice | null) => void;
  rows: PackagingRowState[];
  onRows: (rows: PackagingRowState[]) => void;
}) {
  const uid = useId();
  const [loading, setLoading] = useState(productId !== null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The alternate units of a saved product are read when its form opens.
  useEffect(() => {
    if (productId === null) return;
    let cancelled = false;
    void productUnitsAction(productId).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setLoadError(res.error);
        return;
      }
      onRows(
        res.data.packagings.map((p) => ({
          key: crypto.randomUUID(),
          unitId: p.unitId,
          unitLabel: `${p.unitCode} · ${p.unitName}`,
          qtyPerBase: p.qtyPerBase,
          weightKg: p.weightKg ?? '',
          isSalesDefault: p.isSalesDefault,
          isPurchaseDefault: p.isPurchaseDefault,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
    // onRows is the parent's setter and changes every render; the product is what decides a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  const baseCode = base?.meta?.code ?? base?.label.split(' · ')[0] ?? 'base unit';
  const update = (index: number, change: Partial<PackagingRowState>) =>
    onRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
  // Only one row can be the default for selling (or for buying): ticking one clears the others.
  const makeDefault = (
    index: number,
    key: 'isSalesDefault' | 'isPurchaseDefault',
    value: boolean,
  ) => onRows(rows.map((r, i) => ({ ...r, [key]: i === index ? value : r[key] && !value })));

  return (
    <section className="space-y-3" aria-label="Units of measure">
      <ChoicePicker
        label="Unit of measure (stock is counted in this)"
        source="units-of-measure"
        choice={base}
        onChoice={onBase}
        clearable={false}
        required
        placeholder="Choose a unit, for example kg or piece"
        createHref="/admin/settings/units/new"
        createLabel="Create a new unit"
        listHref="/admin/settings/units/browse"
        listLabel="View all units"
      />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-bold text-fg-strong">
            Other units this product is kept, bought or sold in
          </h4>
          <button
            type="button"
            className={buttonClass}
            disabled={loading || rows.length >= MAX_PACKAGINGS || base === null}
            onClick={() => onRows([...rows, newPackagingRow()])}
          >
            Add a unit
          </button>
        </div>
        {loading ? (
          <p role="status" className="text-xs text-fg-muted">
            Loading units…
          </p>
        ) : null}
        {loadError === null ? null : (
          <p role="alert" className="text-xs text-red-700">
            {loadError}
          </p>
        )}
        {!loading && rows.length === 0 ? (
          <p className="text-xs text-fg-muted">
            None. For example a crate that holds 20 kg of fish.
          </p>
        ) : null}
        {rows.map((row, index) => (
          <div
            key={row.key}
            className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2"
            role="group"
            aria-label={`Alternate unit ${String(index + 1)}`}
          >
            <ChoicePicker
              label="Unit"
              source="units-of-measure"
              filters={base === null ? {} : { exclude: base.id }}
              choice={row.unitId === '' ? null : { id: row.unitId, label: row.unitLabel }}
              onChoice={(c) => update(index, { unitId: c?.id ?? '', unitLabel: c?.label ?? '' })}
              placeholder="Choose a unit"
              clearable={false}
              required
              createHref="/admin/settings/units/new"
              createLabel="Create a new unit"
              listHref="/admin/settings/units/browse"
              listLabel="View all units"
            />
            <div>
              <label
                htmlFor={`${uid}-q${String(index)}`}
                className="mb-1 block text-xs font-semibold text-fg"
              >
                {`1 ${row.unitLabel === '' ? 'of this unit' : (row.unitLabel.split(' · ')[0] ?? '')} = how many ${baseCode}`}
              </label>
              <input
                id={`${uid}-q${String(index)}`}
                inputMode="decimal"
                className={`${fieldClass} font-mono`}
                value={row.qtyPerBase}
                onChange={(e) => update(index, { qtyPerBase: e.target.value })}
                placeholder="e.g. 20"
                required
              />
            </div>
            <div>
              <label
                htmlFor={`${uid}-w${String(index)}`}
                className="mb-1 block text-xs font-semibold text-fg"
              >
                Shipping weight of one (kg, optional)
              </label>
              <input
                id={`${uid}-w${String(index)}`}
                inputMode="decimal"
                className={`${fieldClass} font-mono`}
                value={row.weightKg}
                onChange={(e) => update(index, { weightKg: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap items-end gap-x-4 pb-1">
              <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={row.isSalesDefault}
                  onChange={(e) => makeDefault(index, 'isSalesDefault', e.target.checked)}
                />
                Default for selling
              </label>
              <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={row.isPurchaseDefault}
                  onChange={(e) => makeDefault(index, 'isPurchaseDefault', e.target.checked)}
                />
                Default for buying
              </label>
              <button
                type="button"
                className={buttonClass}
                onClick={() => onRows(rows.filter((_, i) => i !== index))}
                aria-label={`Remove alternate unit ${String(index + 1)}`}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
