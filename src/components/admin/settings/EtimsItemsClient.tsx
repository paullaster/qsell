'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useState, useTransition } from 'react';
import {
  listEtimsItemsAction,
  listRemoteEtimsItemsAction,
  reconcileEtimsItemAction,
  registerEtimsItemAction,
  removeEtimsItemAction,
  updateEtimsItemAction,
  updateEtimsStockAction,
  type ActionResult,
  type EtimsItems,
  type EtimsItemView,
} from '@/server/domains/kra/etims/actions';
import type { EtimsTargetView, RemoteEtimsItem } from '@/server/domains/kra/etims/item-service';

import { has } from '@/lib/values';

const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';
const buttonClass =
  'min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg hover:bg-hover disabled:opacity-50';

const STATUS_STYLE: Record<EtimsItemView['status'], string> = {
  registered: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700',
  pending: 'border-amber-500/20 bg-amber-500/10 text-amber-700',
  unconfirmed: 'border-amber-500/20 bg-amber-500/10 text-amber-700',
  failed: 'border-red-500/20 bg-red-500/10 text-red-700',
  deleted: 'border-line bg-surface-sunken text-fg-muted',
};

const ITEMS_PATH = '/admin/settings/tax-compliance/kra-tims-etims/items';

const targetKey = (t: EtimsTargetView) => (t.scope === 'company' ? 'company' : t.branchId!);

export function EtimsItemsClient({ targets }: { targets: EtimsTargetView[] }) {
  const uid = useId();
  // The list of targets can change while this page is open (e.g. after saving a mode in the
  // dialog), so the selection is derived from props rather than frozen at first render.
  const [chosenKey, setChosenKey] = useState('');
  const target = targets.find((t) => targetKey(t) === chosenKey) ?? targets[0] ?? null;
  const selectedKey = target ? targetKey(target) : '';
  // Null means the company; a branch id is only ever offered for independent eTIMS branches.
  const branchId = target?.scope === 'branch' ? target.branchId : null;
  const [data, setData] = useState<EtimsItems | null>(null);
  const [remote, setRemote] = useState<RemoteEtimsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async (id: string | null) => {
    const res = await listEtimsItemsAction(id);
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setData(null);
      setError(res.error);
    }
  }, []);

  useEffect(() => {
    if (target?.usable !== true) {
      setData(null);
      return;
    }
    setRemote(null);
    setNotice(null);
    void load(branchId);
  }, [target, branchId, load]);

  /** Runs an action, reports the outcome, and refreshes the list. */
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
      await load(branchId);
    });

  if (targets.length === 0 || !target) {
    return (
      <div className="max-w-2xl space-y-2">
        <h2 className="text-xl font-bold text-fg-strong">eTIMS items</h2>
        <p className="text-sm text-fg-muted">
          eTIMS items are available only when the company mode, or the mode of a branch that acts
          independently, is set to eTIMS. Configure that under{' '}
          <Link
            href={`${ITEMS_PATH}/company-mode`}
            className="font-semibold text-indigo-500 underline"
          >
            Company Mode
          </Link>{' '}
          or{' '}
          <Link
            href={`${ITEMS_PATH}/branch-modes`}
            className="font-semibold text-indigo-500 underline"
          >
            Branch Modes
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-fg-strong">eTIMS items</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Company items are used by every branch that does not act independently. A branch that acts
          independently registers and uses its own items.
        </p>
      </div>

      <div className="max-w-sm">
        <label htmlFor={`${uid}-target`} className="mb-1 block text-xs font-semibold text-fg">
          Register items for
        </label>
        <select
          id={`${uid}-target`}
          value={selectedKey}
          onChange={(e) => setChosenKey(e.target.value)}
          className={fieldClass}
        >
          {targets.map((t) => (
            <option key={targetKey(t)} value={targetKey(t)}>
              {t.scope === 'company'
                ? 'Company (all branches that do not act independently)'
                : `${t.label} (${t.code}) — independent branch`}
            </option>
          ))}
        </select>
      </div>

      {!target.usable ? (
        <p
          role="alert"
          className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700"
        >
          eTIMS is not usable here: {target.reason}
        </p>
      ) : null}

      <div aria-live="polite">
        {has(error) ? (
          <p
            role="alert"
            className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
        {has(notice) ? (
          <p role="status" className="text-sm text-emerald-700">
            {notice}
          </p>
        ) : null}
      </div>

      {data ? (
        <>
          <RegisterForm
            key={selectedKey}
            products={data.registrable}
            disabled={pending}
            onRegister={(input) =>
              act(() => registerEtimsItemAction({ branchId, ...input }), 'Item sent to KRA.')
            }
          />

          <section aria-label="Registered items" className="space-y-3">
            {data.items.length === 0 ? (
              <p className="text-sm text-fg-subtle">No items registered here yet.</p>
            ) : (
              data.items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  disabled={pending}
                  onStock={(quantity) =>
                    act(
                      () =>
                        updateEtimsStockAction({ branchId, productId: item.productId, quantity }),
                      'Stock updated at KRA.',
                    )
                  }
                  onResync={() =>
                    act(
                      () => updateEtimsItemAction({ branchId, productId: item.productId }),
                      'Item details re-sent to KRA.',
                    )
                  }
                  onReconcile={() =>
                    act(
                      () => reconcileEtimsItemAction({ branchId, productId: item.productId }),
                      'KRA item code found.',
                    )
                  }
                  onDelete={() => {
                    if (!window.confirm(`Delete "${item.productName}" from KRA?`)) return;
                    act(
                      () => removeEtimsItemAction({ branchId, productId: item.productId }),
                      'Item deleted at KRA.',
                    );
                  }}
                />
              ))
            )}
          </section>

          <section aria-label="Items at KRA" className="space-y-3">
            <button
              type="button"
              className={buttonClass}
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const res = await listRemoteEtimsItemsAction(branchId);
                  if (res.ok) {
                    setRemote(res.data);
                    setError(null);
                  } else {
                    setError(res.error);
                  }
                })
              }
            >
              Compare with KRA
            </button>
            {remote ? <RemoteTable items={remote} /> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function RegisterForm({
  products,
  disabled,
  onRegister,
}: {
  products: EtimsItems['registrable'];
  disabled: boolean;
  onRegister: (input: {
    productId: string;
    qtyUnitCode: string;
    pkgUnitCode: string;
    itemClassCode: string;
    initialStock: number;
  }) => void;
}) {
  const uid = useId();
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('');
  const [pkg, setPkg] = useState('');
  const [cls, setCls] = useState('');
  const [stock, setStock] = useState('0');

  const choose = (id: string) => {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    setQty(p?.qtyUnitCode ?? '');
    setPkg(p?.pkgUnitCode ?? '');
    setCls(p?.itemClassCode ?? '');
    setStock(String(p?.stock ?? 0));
  };

  return (
    <form
      aria-label="Register item"
      className="space-y-4 rounded-xl border border-line bg-surface-raised p-4 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        onRegister({
          productId,
          qtyUnitCode: qty,
          pkgUnitCode: pkg,
          itemClassCode: cls,
          initialStock: Number(stock),
        });
        choose('');
      }}
    >
      <h3 className="text-base font-bold text-fg-strong">Register a product</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-p`} className="mb-1 block text-xs font-semibold text-fg">
            Product
          </label>
          <select
            id={`${uid}-p`}
            required
            value={productId}
            onChange={(e) => choose(e.target.value)}
            className={fieldClass}
          >
            <option value="">Select a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.hasEtimsTaxCode}>
                {p.name} ({p.sku}){p.hasEtimsTaxCode ? '' : ' — no eTIMS tax code'}
              </option>
            ))}
          </select>
        </div>
        {(
          [
            ['q', 'Quantity unit code', qty, setQty, 'U'],
            ['k', 'Package unit code', pkg, setPkg, 'CT'],
            ['c', 'Item classification code', cls, setCls, '99000000'],
          ] as const
        ).map(([key, label, value, setter, placeholder]) => (
          <div key={key}>
            <label htmlFor={`${uid}-${key}`} className="mb-1 block text-xs font-semibold text-fg">
              {label}
            </label>
            <input
              id={`${uid}-${key}`}
              required
              value={value}
              placeholder={placeholder}
              onChange={(e) => setter(e.target.value)}
              className={`${fieldClass} font-mono`}
            />
          </div>
        ))}
        <div>
          <label htmlFor={`${uid}-s`} className="mb-1 block text-xs font-semibold text-fg">
            Opening stock
          </label>
          <input
            id={`${uid}-s`}
            type="number"
            min={0}
            step={1}
            required
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            className={fieldClass}
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={disabled || !has(productId)}
        className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        Register with KRA
      </button>
    </form>
  );
}

function ItemCard({
  item,
  disabled,
  onStock,
  onResync,
  onReconcile,
  onDelete,
}: {
  item: EtimsItemView;
  disabled: boolean;
  onStock: (quantity: number) => void;
  onResync: () => void;
  onReconcile: () => void;
  onDelete: () => void;
}) {
  const uid = useId();
  const [stock, setStock] = useState(String(item.stockQuantity));
  useEffect(() => setStock(String(item.stockQuantity)), [item.stockQuantity]);
  const confirmed = item.status === 'registered';

  return (
    <article className="space-y-3 rounded-xl border border-line bg-surface-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold text-fg-strong">{item.productName}</h3>
          <p className="text-xs text-fg-muted">
            {item.sku} · KRA code{' '}
            <span className="font-mono">{item.kraItemCode ?? 'not assigned'}</span>
          </p>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_STYLE[item.status]}`}
        >
          {item.status}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {(
          [
            ['Tax code', item.taxCode],
            ['Units (qty / pkg)', `${item.qtyUnitCode} / ${item.pkgUnitCode}`],
            ['Class', item.itemClassCode],
            ['Price', item.unitPrice.toLocaleString()],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-fg-muted">{k}</dt>
            <dd className="font-mono text-fg-strong">{v}</dd>
          </div>
        ))}
      </dl>

      {has(item.errorMessage) ? (
        <p role="alert" className="text-xs text-red-700">
          {item.errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        {confirmed ? (
          <div className="flex items-end gap-2">
            <div>
              <label htmlFor={`${uid}-st`} className="mb-1 block text-xs font-semibold text-fg">
                Stock at KRA
              </label>
              <input
                id={`${uid}-st`}
                type="number"
                min={0}
                step={1}
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                className={`${fieldClass} w-28`}
              />
            </div>
            <button
              type="button"
              className={buttonClass}
              disabled={disabled || stock === '' || Number(stock) === item.stockQuantity}
              onClick={() => onStock(Number(stock))}
            >
              Update stock
            </button>
            <button type="button" className={buttonClass} disabled={disabled} onClick={onResync}>
              Re-sync details
            </button>
          </div>
        ) : null}
        {item.status === 'unconfirmed' ? (
          <button type="button" className={buttonClass} disabled={disabled} onClick={onReconcile}>
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
            Delete
          </button>
        ) : null}
      </div>
    </article>
  );
}

function RemoteTable({ items }: { items: RemoteEtimsItem[] }) {
  if (items.length === 0) return <p className="text-sm text-fg-subtle">KRA reports no items.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[32rem] text-left text-xs">
        <caption className="sr-only">Items registered at KRA for this branch</caption>
        <thead className="border-b border-line bg-surface/70 text-fg-muted uppercase">
          <tr>
            <th scope="col" className="px-3 py-2">
              Code
            </th>
            <th scope="col" className="px-3 py-2">
              Name
            </th>
            <th scope="col" className="px-3 py-2">
              Stock
            </th>
            <th scope="col" className="px-3 py-2">
              In this app
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {items.map((i, idx) => (
            <tr key={i.itemCode ?? idx}>
              <td className="px-3 py-2 font-mono">{i.itemCode ?? '—'}</td>
              <td className="px-3 py-2">{i.name ?? '—'}</td>
              <td className="px-3 py-2">{i.stock ?? '—'}</td>
              <td className="px-3 py-2">{has(i.localItemId) ? 'Linked' : 'Not linked'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
