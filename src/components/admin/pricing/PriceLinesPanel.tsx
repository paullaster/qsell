'use client';

import { Fragment, useCallback, useEffect, useId, useState } from 'react';
import {
  importPriceLinesAction,
  listPriceLinesAction,
  listPricingReasonsAction,
  priceHistoryAction,
  removePriceLinesAction,
  savePriceLinesAction,
  searchProductsAction,
  type PriceLineView,
} from '@/server/domains/pricing/actions';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  EmptyState,
  Notice,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { fromLocalInput } from './PriceListForm';

const fmt = (n: number, d = 2) =>
  n.toLocaleString('en-KE', { minimumFractionDigits: d, maximumFractionDigits: 4 });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-KE');

interface Draft {
  productId: string;
  productLabel: string;
  price: string;
  floor: string;
  lockedUntil: string;
  startsAt: string;
  breaks: Array<{ fromQty: string; price: string }>;
}
const blank = (): Draft => ({
  productId: '',
  productLabel: '',
  price: '',
  floor: '',
  lockedUntil: '',
  startsAt: '',
  breaks: [],
});

/** The prices in a list: find, add, change, schedule, remove, import, and see how each one changed. */
export function PriceLinesPanel({
  listId,
  editable,
  live,
  quantityMode,
  onChanged,
}: {
  listId: string;
  /** False for a retired list or one waiting for approval. */
  editable: boolean;
  /** True when changes take effect on real sales. */
  live: boolean;
  quantityMode: 'all_units' | 'incremental';
  onChanged: () => void;
}) {
  const uid = useId();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{
    rows: PriceLineView[];
    total: number;
    pageSize: number;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const [csv, setCsv] = useState('');
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{
    productId: string;
    rows: Array<{ validFrom: string; validTo: string | null; price: number; by: string }>;
  } | null>(null);
  const [lockOverride, setLockOverride] = useState(false);
  const [removing, setRemoving] = useState<PriceLineView | null>(null);

  const load = useCallback(async () => {
    const r = await listPriceLinesAction(listId, { search, page });
    if (r.ok) {
      setData(r.data);
      setLoadError(null);
    } else setLoadError(r.error);
  }, [listId, search, page]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const finish = async (text: string) => {
    setMessage({ kind: 'ok', text });
    setDraft(null);
    setImporting(false);
    setRemoving(null);
    setCsv('');
    setReason({ code: '', text: '' });
    setLockOverride(false);
    await load();
    onChanged();
  };
  const fail = (r: { error: string; code?: string; issues?: Array<{ message: string }> }) => {
    const extra =
      r.issues && r.issues.length > 1
        ? ` ${r.issues
            .slice(0, 5)
            .map((i) => i.message)
            .join(' ')}`
        : '';
    setMessage({ kind: 'error', text: `${r.error}${extra}` });
    if (r.code === 'LOCKED') setLockOverride(false);
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    const r = await savePriceLinesAction(
      listId,
      [
        {
          productId: draft.productId,
          price: Number(draft.price),
          floorPrice: draft.floor === '' ? null : Number(draft.floor),
          lockedUntil: draft.lockedUntil ? new Date(draft.lockedUntil).toISOString() : null,
          tiers: draft.breaks
            .filter((b) => b.fromQty !== '' || b.price !== '')
            .map((b) => ({ fromQty: Number(b.fromQty), price: Number(b.price) })),
        },
      ],
      reason,
      { validFrom: fromLocalInput(draft.startsAt), overrideLock: lockOverride },
    );
    setBusy(false);
    if (r.ok) {
      const { created, replaced, unchanged } = r.data;
      await finish(
        unchanged
          ? 'That price was already set; nothing changed.'
          : replaced
            ? 'Price changed. The old price is kept in its history.'
            : created
              ? 'Price added.'
              : 'Done.',
      );
    } else fail(r);
  };

  const runImport = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setMessage(null);
    const r = await importPriceLinesAction(listId, csv, reason, { overrideLock: lockOverride });
    setBusy(false);
    if (r.ok)
      await finish(
        `${r.data.created} added, ${r.data.replaced} changed, ${r.data.unchanged} already as given.`,
      );
    else fail(r);
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setMessage(null);
    const r = await removePriceLinesAction(listId, [removing.productId], reason, {
      overrideLock: lockOverride,
    });
    setBusy(false);
    if (r.ok) await finish(`${removing.name} is no longer priced in this list.`);
    else fail(r);
  };

  const showHistory = async (line: PriceLineView) => {
    if (history?.productId === line.productId) return setHistory(null);
    const r = await priceHistoryAction(listId, line.productId);
    if (r.ok) setHistory({ productId: line.productId, rows: r.data });
  };

  const edit = (line: PriceLineView) => {
    setImporting(false);
    setDraft({
      productId: line.productId,
      productLabel: `${line.name} (${line.sku})`,
      price: String(line.price),
      floor: line.floorPrice == null ? '' : String(line.floorPrice),
      lockedUntil: line.lockedUntil ? line.lockedUntil.slice(0, 10) : '',
      startsAt: '',
      breaks: line.tiers.map((t) => ({ fromQty: String(t.fromQty), price: String(t.price) })),
    });
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const needsReason = draft || importing || removing;

  return (
    <section aria-labelledby={`${uid}-h`} className={`${cardClass} space-y-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${uid}-h`} className="text-sm font-bold text-fg-strong">
          Prices{' '}
          {data ? (
            <span className="font-normal text-fg-muted">({data.total.toLocaleString()})</span>
          ) : null}
        </h3>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                setImporting(false);
                setDraft(blank());
              }}
            >
              Add or change a price
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setDraft(null);
                setImporting(true);
              }}
            >
              Import from a file
            </button>
          </div>
        ) : null}
      </div>

      {live ? (
        <p className="text-xs text-fg-muted">
          This list is in force. A change starts now (or at the time you set) and applies to the
          next sale; sales already made keep the price they were given.
        </p>
      ) : null}

      {draft ? (
        <form onSubmit={save} className="space-y-3 rounded-lg border border-line p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <ProductPick
                value={draft.productLabel}
                onPick={(p) =>
                  setDraft({ ...draft, productId: p.id, productLabel: `${p.name} (${p.sku})` })
                }
                onClear={() => setDraft({ ...draft, productId: '', productLabel: '' })}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-price`} className={labelClass}>
                Price
              </label>
              <input
                id={`${uid}-price`}
                type="number"
                min="0"
                step="0.0001"
                className={fieldClass}
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor={`${uid}-floor`} className={labelClass}>
                Floor price (optional)
              </label>
              <input
                id={`${uid}-floor`}
                type="number"
                min="0"
                step="0.0001"
                className={fieldClass}
                value={draft.floor}
                onChange={(e) => setDraft({ ...draft, floor: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-starts`} className={labelClass}>
                Starts (empty means now)
              </label>
              <input
                id={`${uid}-starts`}
                type="datetime-local"
                className={fieldClass}
                value={draft.startsAt}
                onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-lock`} className={labelClass}>
                Lock until (optional)
              </label>
              <input
                id={`${uid}-lock`}
                type="date"
                className={fieldClass}
                value={draft.lockedUntil}
                onChange={(e) => setDraft({ ...draft, lockedUntil: e.target.value })}
              />
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-fg">Quantity breaks</legend>
            <p className="text-xs text-fg-muted">
              {quantityMode === 'all_units'
                ? 'From this many units, every unit costs the break price.'
                : 'From this unit onward, units cost the break price (a break at 51 prices the 51st unit and up).'}
            </p>
            {draft.breaks.map((b, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div>
                  <label className={labelClass} htmlFor={`${uid}-bq${i}`}>
                    From unit
                  </label>
                  <input
                    id={`${uid}-bq${i}`}
                    type="number"
                    min="1"
                    className={`${fieldClass} w-28`}
                    value={b.fromQty}
                    onChange={(e) => {
                      const breaks = [...draft.breaks];
                      breaks[i] = { ...b, fromQty: e.target.value };
                      setDraft({ ...draft, breaks });
                    }}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor={`${uid}-bp${i}`}>
                    Price
                  </label>
                  <input
                    id={`${uid}-bp${i}`}
                    type="number"
                    min="0"
                    step="0.0001"
                    className={`${fieldClass} w-32`}
                    value={b.price}
                    onChange={(e) => {
                      const breaks = [...draft.breaks];
                      breaks[i] = { ...b, price: e.target.value };
                      setDraft({ ...draft, breaks });
                    }}
                  />
                </div>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() =>
                    setDraft({ ...draft, breaks: draft.breaks.filter((_, j) => j !== i) })
                  }
                >
                  Remove break
                </button>
              </div>
            ))}
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                setDraft({ ...draft, breaks: [...draft.breaks, { fromQty: '', price: '' }] })
              }
            >
              Add a quantity break
            </button>
          </fieldset>
        </form>
      ) : null}

      {importing ? (
        <form onSubmit={runImport} className="space-y-2 rounded-lg border border-line p-3">
          <label htmlFor={`${uid}-csv`} className={labelClass}>
            Paste prices, one product per line
          </label>
          <p className="text-xs text-fg-muted">
            Columns: <code>sku, price, floor price, breaks</code>. Floor price and breaks are
            optional; breaks read like <code>50:90;100:85</code> (from 50 units, 90 each). If any
            row has a problem, nothing is changed.
          </p>
          <textarea
            id={`${uid}-csv`}
            rows={6}
            className={`${fieldClass} font-mono`}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={'SKU-001,1200,1000,50:1100;100:1050\nSKU-002,350'}
            required
          />
        </form>
      ) : null}

      {needsReason ? (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-xs text-fg">
            <input
              type="checkbox"
              className="size-4"
              checked={lockOverride}
              onChange={(e) => setLockOverride(e.target.checked)}
            />
            Replace prices that are locked (recorded in the history)
          </label>
          {draft ? (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={busy || !reason.code || !draft.productId || draft.price === ''}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save price'}
            </button>
          ) : null}
          {importing ? (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={busy || !reason.code || !csv.trim()}
              onClick={() => void runImport()}
            >
              {busy ? 'Importing…' : 'Import prices'}
            </button>
          ) : null}
          {removing ? (
            <>
              <p className="text-sm text-fg-strong">
                Stop pricing {removing.name} in this list? Its past prices stay in the history.
              </p>
              <button
                type="button"
                className={primaryButtonClass}
                disabled={busy || !reason.code}
                onClick={() => void remove()}
              >
                {busy ? 'Removing…' : 'Remove price'}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setDraft(null);
              setImporting(false);
              setRemoving(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      <Notice message={message} />

      <div>
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search the prices in this list
        </label>
        <input
          id={`${uid}-search`}
          type="search"
          className={`${fieldClass} sm:max-w-sm`}
          placeholder="Search by name or SKU…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {loadError ? (
        <p role="alert" className="text-sm text-red-700">
          {loadError}
        </p>
      ) : !data ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : data.rows.length === 0 ? (
        <EmptyState title={search ? 'No prices match that search' : 'No prices in this list yet'}>
          {search ? undefined : 'Add a price, or import a file of them.'}
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <caption className="sr-only">Prices in this list</caption>
              <thead className="border-b border-line text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="py-2 pr-3">
                    Product
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right">
                    Standard
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right">
                    This list
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Breaks
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Since
                  </th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((l) => (
                  <Fragment key={l.id}>
                    <tr className="border-b border-line align-top">
                      <th scope="row" className="py-2 pr-3 font-medium text-fg-strong">
                        {l.name}
                        <div className="text-xs font-normal text-fg-muted">{l.sku}</div>
                      </th>
                      <td className="py-2 pr-3 text-right text-fg-muted tabular-nums">
                        {l.standardPrice == null ? '—' : fmt(l.standardPrice)}
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold text-fg-strong tabular-nums">
                        {fmt(l.price)}
                        {l.floorPrice != null ? (
                          <div className="text-xs font-normal text-fg-muted">
                            floor {fmt(l.floorPrice)}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-xs text-fg">
                        {l.tiers.length === 0
                          ? '—'
                          : l.tiers.map((t) => `${t.fromQty}+: ${fmt(t.price)}`).join(' · ')}
                        {l.lockedUntil ? (
                          <div className="text-fg-muted">locked until {day(l.lockedUntil)}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-xs text-fg-muted">{day(l.validFrom)}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <button
                            type="button"
                            className={buttonClass}
                            onClick={() => void showHistory(l)}
                          >
                            History
                          </button>
                          {editable ? (
                            <>
                              <button type="button" className={buttonClass} onClick={() => edit(l)}>
                                Change
                              </button>
                              <button
                                type="button"
                                className={buttonClass}
                                disabled={busy}
                                onClick={() => {
                                  setDraft(null);
                                  setImporting(false);
                                  setRemoving(l);
                                }}
                              >
                                Remove
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {history?.productId === l.productId ? (
                      <tr className="border-b border-line bg-surface-sunken">
                        <td colSpan={6} className="px-3 py-2 text-xs">
                          <p className="mb-1 font-semibold text-fg-strong">
                            Every price {l.name} has had in this list
                          </p>
                          <ul className="space-y-0.5">
                            {history.rows.map((h, i) => (
                              <li key={i} className="tabular-nums">
                                {fmt(h.price)} · from {day(h.validFrom)}
                                {h.validTo ? ` to ${day(h.validTo)}` : ' until changed'}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                className={buttonClass}
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} of {pages}
              </span>
              <button
                type="button"
                className={buttonClass}
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}

export function ProductPick({
  value,
  onPick,
  onClear,
  disabled,
}: {
  value: string;
  onPick: (p: { id: string; name: string; sku: string }) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const uid = useId();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<
    Array<{ id: string; name: string; sku: string; price: string | null }>
  >([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void searchProductsAction(q).then((r) => {
        if (live && r.ok) setFound(r.data);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  if (value)
    return (
      <div>
        <span className={labelClass}>Product</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-fg-strong">{value}</span>
          {!disabled ? (
            <button type="button" className={buttonClass} onClick={onClear}>
              Choose another
            </button>
          ) : null}
        </div>
      </div>
    );
  return (
    <div>
      <label htmlFor={uid} className={labelClass}>
        Product
      </label>
      <input
        id={uid}
        className={fieldClass}
        value={q}
        placeholder="Type a name or SKU…"
        onChange={(e) => setQ(e.target.value)}
      />
      {found.length > 0 ? (
        <ul className="mt-1 max-h-48 divide-y divide-line overflow-auto rounded-lg border border-line">
          {found.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="min-h-10 w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-hover"
                onClick={() => {
                  onPick(p);
                  setQ('');
                }}
              >
                {p.name} <span className="text-fg-muted">{p.sku}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
