'use client';

import { useEffect, useId, useState } from 'react';
import {
  checkPriceAction,
  searchCustomersAction,
  type PriceCheckResult,
  type PricingLookups,
} from '@/server/domains/pricing/actions';
import {
  Chip,
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { PriceTraceView } from './PriceTraceView';
import { ProductPick } from './PriceLinesPanel';
import { toLocalInput } from './PriceListForm';

const CHANNELS: Record<string, string> = {
  ecommerce: 'Web shop',
  sales_order: 'Sales order',
  credit_sale: 'Credit sale',
  pos_cash_sale: 'POS cash sale',
};

/** Tries a sale through the real pricing engine and shows the price and every reason behind it. */
export function PriceCheckClient({ lookups }: { lookups: PricingLookups }) {
  const uid = useId();
  const [product, setProduct] = useState<{ id: string; label: string } | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [branchId, setBranchId] = useState('');
  const [salesType, setSalesType] = useState('');
  const [channel, setChannel] = useState('sales_order');
  const [route, setRoute] = useState('');
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [at, setAt] = useState('');
  const [result, setResult] = useState<PriceCheckResult | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;
    setBusy(true);
    setMessage(null);
    const r = await checkPriceAction({
      productId: product.id,
      quantity: Number(quantity),
      customerId: customer?.id ?? null,
      branchId: branchId || null,
      salesType: salesType || null,
      channel: channel || null,
      route: route || null,
      country: country || null,
      currency: currency || null,
      at: at ? new Date(at).toISOString() : null,
    });
    setBusy(false);
    if (r.ok) setResult(r.data);
    else {
      setResult(null);
      setMessage({ kind: 'error', text: r.error });
    }
  };

  const t = result?.result.trace;
  const money = (n: number | null) =>
    n == null
      ? '—'
      : n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

  return (
    <div className="space-y-5">
      <PageHeader title="Price check">
        Try a sale and see the price it would get, and why. This uses exactly the same rules as a
        real order or quote, and saves nothing.
      </PageHeader>
      <form onSubmit={run} className={`${cardClass} space-y-3`} aria-label="Sale to check">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <ProductPick
              value={product?.label ?? ''}
              onPick={(p) => setProduct({ id: p.id, label: `${p.name} (${p.sku})` })}
              onClear={() => setProduct(null)}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-qty`} className={labelClass}>
              Quantity
            </label>
            <input
              id={`${uid}-qty`}
              type="number"
              min="0.001"
              step="any"
              className={fieldClass}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </div>
          <CustomerSelect value={customer} onChange={setCustomer} />
          <div>
            <label htmlFor={`${uid}-branch`} className={labelClass}>
              Branch
            </label>
            <select
              id={`${uid}-branch`}
              className={fieldClass}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">Not specified</option>
              {lookups.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-ch`} className={labelClass}>
              Channel
            </label>
            <select
              id={`${uid}-ch`}
              className={fieldClass}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              <option value="">Not specified</option>
              {lookups.channels.map((c) => (
                <option key={c} value={c}>
                  {CHANNELS[c] ?? c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-st`} className={labelClass}>
              Sales type
            </label>
            <select
              id={`${uid}-st`}
              className={fieldClass}
              value={salesType}
              onChange={(e) => setSalesType(e.target.value)}
            >
              <option value="">Not specified</option>
              <option value="cash">Cash</option>
              <option value="credit">Credit</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-cur`} className={labelClass}>
              Currency
            </label>
            <select
              id={`${uid}-cur`}
              className={fieldClass}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">{lookups.baseCurrency} (base)</option>
              {lookups.currencies
                .filter((c) => !c.isBase)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-route`} className={labelClass}>
              Route (optional)
            </label>
            <input
              id={`${uid}-route`}
              className={fieldClass}
              value={route}
              onChange={(e) => setRoute(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-country`} className={labelClass}>
              Country (optional, e.g. KE)
            </label>
            <input
              id={`${uid}-country`}
              className={fieldClass}
              value={country}
              maxLength={2}
              onChange={(e) => setCountry(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-at`} className={labelClass}>
              As at (empty means now)
            </label>
            <input
              id={`${uid}-at`}
              type="datetime-local"
              className={`${fieldClass} sm:max-w-xs`}
              value={at}
              max={toLocalInput(new Date(Date.now() + 365 * 864e5).toISOString())}
              onChange={(e) => setAt(e.target.value)}
            />
          </div>
        </div>
        <button type="submit" className={primaryButtonClass} disabled={busy || !product}>
          {busy ? 'Working it out…' : 'Check the price'}
        </button>
        <Notice message={message} />
      </form>

      {result && t ? (
        <section aria-live="polite" aria-label="Result" className={`${cardClass} space-y-4`}>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-xs text-fg-muted">
                {result.product.name} · {result.product.sku}
              </p>
              {result.result.unitPrice == null ? (
                <p className="text-2xl font-bold text-red-700">No price</p>
              ) : (
                <p className="text-2xl font-bold text-fg-strong tabular-nums">
                  {money(result.result.unitPrice)}{' '}
                  <span className="text-sm font-normal text-fg-muted">each</span>
                </p>
              )}
              {result.result.lineTotal != null ? (
                <p className="text-sm text-fg tabular-nums">
                  {money(result.result.lineTotal)} for {t.inputs.quantity}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip
                tone={t.source === 'price_list' ? 'green' : t.source === 'standard' ? 'sky' : 'red'}
              >
                {t.source === 'price_list'
                  ? `From ${t.winner?.listCode}`
                  : t.source === 'standard'
                    ? 'Standard price'
                    : 'Cannot be priced'}
              </Chip>
              {result.groupName ? (
                <Chip tone="grey">Customer group: {result.groupName}</Chip>
              ) : null}
            </div>
          </div>
          <PriceTraceView trace={t} />
        </section>
      ) : null}
    </div>
  );
}

function CustomerSelect({
  value,
  onChange,
}: {
  value: { id: string; name: string } | null;
  onChange: (c: { id: string; name: string } | null) => void;
}) {
  const uid = useId();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Array<{ id: string; number: string; name: string }>>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    let live = true;
    const t = setTimeout(() => {
      void searchCustomersAction(q).then((r) => live && r.ok && setFound(r.data));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  if (value)
    return (
      <div>
        <span className={labelClass}>Customer</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-fg-strong">{value.name}</span>
          <button type="button" className={buttonClass} onClick={() => onChange(null)}>
            Choose another
          </button>
        </div>
      </div>
    );
  return (
    <div>
      <label htmlFor={uid} className={labelClass}>
        Customer (optional)
      </label>
      <input
        id={uid}
        className={fieldClass}
        value={q}
        placeholder="Type a name or number…"
        onChange={(e) => setQ(e.target.value)}
      />
      {found.length > 0 ? (
        <ul className="mt-1 max-h-48 divide-y divide-line overflow-auto rounded-lg border border-line">
          {found.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="min-h-10 w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-hover"
                onClick={() => {
                  onChange({ id: f.id, name: f.name });
                  setQ('');
                }}
              >
                {f.name} <span className="text-fg-muted">{f.number}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
