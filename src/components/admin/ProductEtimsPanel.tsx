'use client';

import { useCallback, useEffect, useId, useState, useTransition } from 'react';
import {
  getProductEtimsAction,
  reconcileEtimsItemAction,
  registerEtimsItemAction,
  removeEtimsItemAction,
  updateEtimsItemAction,
  type ActionResult,
} from '@/server/domains/kra/etims/actions';
import type {
  ProductEtimsTargetView,
  ProductEtimsOverview,
} from '@/server/domains/kra/etims/item-service';

const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';
const buttonClass =
  'min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg hover:bg-hover disabled:opacity-50';

const STATUS_STYLE: Record<string, string> = {
  registered: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700',
  pending: 'border-amber-500/20 bg-amber-500/10 text-amber-700',
  unconfirmed: 'border-amber-500/20 bg-amber-500/10 text-amber-700',
  failed: 'border-red-500/20 bg-red-500/10 text-red-700',
};

const DRIFT_LABEL = { name: 'name', price: 'price', taxCode: 'tax code', itemType: 'item type' };

/**
 * KRA eTIMS registration state of one product, per branch. Rendered inside the product
 * form, so it must not contain a <form> of its own — everything here is type="button".
 */
export function ProductEtimsPanel({ productId }: { productId: string }) {
  const [overview, setOverview] = useState<ProductEtimsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const res = await getProductEtimsAction(productId);
    if (res.ok) {
      setOverview(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = <T,>(task: () => Promise<ActionResult<T>>, success: string) =>
    startTransition(async () => {
      setNotice(null);
      const res = await task();
      if (res.ok) {
        setError(null);
        setNotice(success);
      } else {
        setError(res.error);
      }
      await load();
    });

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-bold text-fg-strong">KRA eTIMS registration</h3>
        <p className="mt-1 text-[11px] text-fg-muted">
          Each branch has its own KRA item code. A product must be registered in a branch before it
          can be invoiced there.
        </p>
      </div>

      <div aria-live="polite" className="space-y-1">
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-700"
          >
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-xs text-emerald-700">
            {notice}
          </p>
        ) : null}
      </div>

      {!overview && !error ? <p className="text-xs text-fg-subtle">Loading…</p> : null}

      {overview?.productIssue ? (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-800">
          {overview.productIssue}
        </p>
      ) : null}

      {overview && overview.targets.length === 0 ? (
        <p className="text-xs text-fg-muted">
          eTIMS is not set up for the company or any independent branch.
        </p>
      ) : null}

      {overview?.targets.map((target) => (
        <TargetRow
          key={target.branchId ?? 'company'}
          target={target}
          stock={overview.stock}
          canRegister={!overview.productIssue}
          disabled={pending}
          onRegister={(input) =>
            act(
              () => registerEtimsItemAction({ branchId: target.branchId, productId, ...input }),
              `Sent to KRA for ${target.label}.`,
            )
          }
          onResync={() =>
            act(
              () => updateEtimsItemAction({ branchId: target.branchId, productId }),
              `Details re-sent to KRA for ${target.label}.`,
            )
          }
          onReconcile={() =>
            act(
              () => reconcileEtimsItemAction({ branchId: target.branchId, productId }),
              'KRA item code found.',
            )
          }
          onDelete={() => {
            if (!window.confirm(`Delete this product from KRA for ${target.label}?`)) return;
            act(
              () => removeEtimsItemAction({ branchId: target.branchId, productId }),
              `Deleted from KRA for ${target.label}.`,
            );
          }}
        />
      ))}
    </div>
  );
}

function TargetRow({
  target,
  stock,
  canRegister,
  disabled,
  onRegister,
  onResync,
  onReconcile,
  onDelete,
}: {
  target: ProductEtimsTargetView;
  stock: number | null;
  canRegister: boolean;
  disabled: boolean;
  onRegister: (input: {
    qtyUnitCode: string;
    pkgUnitCode: string;
    itemClassCode: string;
    initialStock: number;
  }) => void;
  onResync: () => void;
  onReconcile: () => void;
  onDelete: () => void;
}) {
  const uid = useId();
  const { item, suggested } = target;
  const [qty, setQty] = useState(suggested.qtyUnitCode);
  const [pkg, setPkg] = useState(suggested.pkgUnitCode);
  const [cls, setCls] = useState(suggested.itemClassCode);
  const [openStock, setOpenStock] = useState(String(stock ?? 0));

  const complete = qty.trim() && pkg.trim() && cls.trim() && openStock !== '';

  return (
    <section
      aria-label={`${target.label} eTIMS`}
      className="space-y-3 rounded-xl border border-line bg-surface-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold text-fg-strong">
          {target.scope === 'company' ? 'Company' : target.label}{' '}
          <span className="text-[11px] font-normal text-fg-muted">
            {target.scope === 'company'
              ? '— used by branches that do not act independently'
              : `(${target.code}) — independent branch`}
          </span>
        </h4>
        {item ? (
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_STYLE[item.status] ?? ''}`}
          >
            {item.status}
          </span>
        ) : null}
      </div>

      {!target.usable ? (
        <p role="alert" className="text-xs text-red-700">
          KRA configuration unavailable: {target.reason}
        </p>
      ) : null}

      {target.usable && item ? (
        <>
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {(
              [
                ['KRA code', item.kraItemCode ?? 'not assigned'],
                ['Tax code', item.taxCode],
                ['Units (qty / pkg)', `${item.qtyUnitCode} / ${item.pkgUnitCode}`],
                ['Class', item.itemClassCode],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-fg-muted">{k}</dt>
                <dd className="font-mono break-all text-fg-strong">{v}</dd>
              </div>
            ))}
          </dl>
          {item.drift.length > 0 ? (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-800">
              Out of date at KRA: {item.drift.map((d) => DRIFT_LABEL[d]).join(', ')} changed since
              it was last sent. Re-sync to update KRA.
            </p>
          ) : null}
          {item.errorMessage ? (
            <p role="alert" className="text-xs text-red-700">
              {item.errorMessage}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {item.status === 'registered' ? (
              <button type="button" className={buttonClass} disabled={disabled} onClick={onResync}>
                Re-sync details
              </button>
            ) : null}
            {item.status === 'unconfirmed' ? (
              <button
                type="button"
                className={buttonClass}
                disabled={disabled}
                onClick={onReconcile}
              >
                Find KRA code
              </button>
            ) : null}
            {item.status !== 'pending' && item.status !== 'unconfirmed' ? (
              <button
                type="button"
                className={`${buttonClass} border-red-500/30 text-red-700`}
                disabled={disabled}
                onClick={onDelete}
              >
                {item.status === 'failed' ? 'Discard' : 'Delete'}
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {target.usable && !item ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['q', 'Quantity unit', qty, setQty, 'U'],
                ['k', 'Package unit', pkg, setPkg, 'CT'],
                ['c', 'Classification code', cls, setCls, '99000000'],
              ] as const
            ).map(([key, label, value, setter, placeholder]) => (
              <div key={key}>
                <label
                  htmlFor={`${uid}-${key}`}
                  className="mb-1 block text-[11px] font-semibold text-fg-muted"
                >
                  {label}
                </label>
                <input
                  id={`${uid}-${key}`}
                  value={value}
                  placeholder={placeholder}
                  onChange={(e) => setter(e.target.value)}
                  className={`${fieldClass} font-mono`}
                />
              </div>
            ))}
            <div>
              <label
                htmlFor={`${uid}-s`}
                className="mb-1 block text-[11px] font-semibold text-fg-muted"
              >
                Opening stock
              </label>
              <input
                id={`${uid}-s`}
                type="number"
                min={0}
                step={1}
                value={openStock}
                onChange={(e) => setOpenStock(e.target.value)}
                className={fieldClass}
              />
            </div>
          </div>
          <button
            type="button"
            className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            disabled={disabled || !canRegister || !complete}
            onClick={() =>
              onRegister({
                qtyUnitCode: qty,
                pkgUnitCode: pkg,
                itemClassCode: cls,
                initialStock: Number(openStock),
              })
            }
          >
            Register with KRA
          </button>
        </div>
      ) : null}
    </section>
  );
}
