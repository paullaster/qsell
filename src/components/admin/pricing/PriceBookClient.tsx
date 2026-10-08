'use client';

import { useEffect, useId, useState } from 'react';
import type { DiscountLookups } from '@/server/domains/pricing/discount-actions';
import { exportPriceBookAction, priceBookAction } from '@/server/domains/pricing/insights-actions';
import type { BookPage } from '@/server/domains/pricing/price-book-service';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { CustomerLookup, type PickedCustomer } from './CustomerLookup';
import { money } from './DiscountsClient';

const PAGE = 50;

export function PriceBookClient({ lookups }: { lookups: DiscountLookups }) {
  const uid = useId();
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [branchId, setBranchId] = useState('');
  const [channel, setChannel] = useState('sales_order');
  const [salesType, setSalesType] = useState('');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brand, setBrand] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<BookPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const ctx = {
    customerId: customer?.id ?? null,
    branchId: branchId || null,
    channel,
    salesType: salesType || null,
  };
  const query = { search, categoryId: categoryId || null, brand: brand || null };
  const signature = JSON.stringify([ctx, query, offset]);

  // Any change to the situation or the filter starts again from the first page.
  useEffect(
    () => setOffset(0),
    [customer, branchId, channel, salesType, search, categoryId, brand],
  );

  useEffect(() => {
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      void priceBookAction(ctx, { ...query, limit: PAGE, offset }).then((r) => {
        if (!live) return;
        setBusy(false);
        if (r.ok) {
          setPage(r.data);
          setMessage(null);
        } else setMessage({ kind: 'error', text: r.error });
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // The signature stands for every input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const download = async () => {
    setBusy(true);
    const r = await exportPriceBookAction(ctx, query);
    setBusy(false);
    if (!r.ok) return setMessage({ kind: 'error', text: r.error });
    try {
      const url = URL.createObjectURL(new Blob([r.data.csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `price-book-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage({
        kind: 'ok',
        text: `Saved ${r.data.rows.toLocaleString()} products${r.data.truncated ? ' (the first 5,000: narrow the search for the rest)' : ''}.`,
      });
    } catch {
      setMessage({ kind: 'error', text: 'Could not save the file.' });
    }
  };

  const total = page?.total ?? 0;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Price book"
        actions={
          <button
            type="button"
            className={primaryButtonClass}
            onClick={() => void download()}
            disabled={busy || total === 0}
          >
            Download as a spreadsheet
          </button>
        }
      >
        What each product sells for, one unit, in the situation you choose: the price list or
        standard price, less the line discounts that apply. It is worked out live by the same engine
        that prices an order, so it is never out of date. Order-level discounts and coupons are not
        included.
      </PageHeader>

      <section aria-label="Situation" className={`${cardClass} space-y-3`}>
        <CustomerLookup value={customer} onChange={setCustomer} label="For customer (optional)" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor={`${uid}-br`} className={labelClass}>
              Branch
            </label>
            <select
              id={`${uid}-br`}
              className={fieldClass}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">Any branch</option>
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
              {lookups.channels.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-st`} className={labelClass}>
              Sale type
            </label>
            <select
              id={`${uid}-st`}
              className={fieldClass}
              value={salesType}
              onChange={(e) => setSalesType(e.target.value)}
            >
              <option value="">Any</option>
              {lookups.salesTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor={`${uid}-s`} className={labelClass}>
              Find a product (name or SKU)
            </label>
            <input
              id={`${uid}-s`}
              className={fieldClass}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-c`} className={labelClass}>
              Category
            </label>
            <select
              id={`${uid}-c`}
              className={fieldClass}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">All categories</option>
              {lookups.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${'— '.repeat(c.depth)}${c.name}`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-bd`} className={labelClass}>
              Brand
            </label>
            <select
              id={`${uid}-bd`}
              className={fieldClass}
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
            >
              <option value="">All brands</option>
              {lookups.brands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <Notice message={message} />
      {busy && !page ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}

      {page && page.rows.length === 0 ? (
        <EmptyState title="No products match">
          Change the filter, or check the product is active and for sale.
        </EmptyState>
      ) : null}
      {page && page.rows.length > 0 ? (
        <section aria-label="Prices" className={`${cardClass} space-y-3`}>
          <div className="overflow-x-auto" aria-busy={busy}>
            <table className="w-full min-w-[56rem] text-sm">
              <caption className="sr-only">Price book</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-fg-muted">
                  <th className="py-2 pr-3 font-semibold">Product</th>
                  <th className="py-2 pr-3 text-right font-semibold">List (net)</th>
                  <th className="py-2 pr-3 text-right font-semibold">After discounts (net)</th>
                  <th className="py-2 pr-3 text-right font-semibold">As sold</th>
                  <th className="py-2 pr-3 text-right font-semibold">Margin</th>
                  <th className="py-2 font-semibold">Where it comes from</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={r.productId} className="border-b border-line/60 align-top">
                    <td className="py-2 pr-3">
                      <span className="font-semibold text-fg-strong">{r.name}</span>{' '}
                      <span className="text-xs text-fg-muted">{r.sku}</span>
                      {r.belowFloor ? (
                        <span className="ml-1">
                          <Chip tone="red">Below floor {money(r.floorNet ?? 0)}</Chip>
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {r.listNet == null ? '–' : money(r.listNet)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {r.effectiveNet == null ? '–' : money(r.effectiveNet)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {r.effectiveUnit == null ? '–' : money(r.effectiveUnit)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {r.marginPercent == null ? '–' : `${r.marginPercent}%`}
                    </td>
                    <td className="py-2 text-xs text-fg-muted">
                      {r.problem ?? r.source}
                      {r.discounts.length > 0 ? ` · ${r.discounts.join(', ')}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-fg-muted" role="status">
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={offset === 0 || busy}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                Previous
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={offset + PAGE >= total || busy}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
