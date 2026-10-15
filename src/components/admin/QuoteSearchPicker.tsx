'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { searchSalesQuotesAction } from '@/server/domains/quotes/actions';
import type { QuoteSearchHit } from '@/server/domains/quotes/service';

export const QUOTE_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'converted',
  'cancelled',
] as const;

export const statusText = (status: string) => status.replace(/_/g, ' ');

const money = (n: number, currency: string) =>
  `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'No expiry');

const tone = (status: string, expired: boolean) =>
  expired
    ? 'bg-red-100 text-red-800'
    : status === 'accepted' || status === 'converted'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'rejected' || status === 'cancelled' || status === 'expired'
        ? 'bg-red-100 text-red-800'
        : 'bg-surface-sunken text-fg';

/** One quote, as the picker shows it: number, customer, total, status, valid until. */
export function QuoteSummary({ hit }: { hit: QuoteSearchHit }) {
  return (
    <span className="grid w-full gap-x-3 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)_8rem_7rem_6rem] sm:items-center">
      <span className="font-mono text-xs font-semibold text-fg-strong">{hit.quoteNumber}</span>
      <span className="min-w-0 truncate text-sm text-fg-strong">{hit.customerName}</span>
      <span className="font-mono text-xs text-fg sm:text-right">
        {money(hit.totalAmount, hit.currency)}
      </span>
      <span>
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${tone(hit.status, hit.expired)}`}
        >
          {hit.expired ? 'expired' : statusText(hit.status)}
        </span>
      </span>
      <span className="text-xs text-fg-muted">
        <span className="sm:hidden">Valid until </span>
        {day(hit.validUntil)}
      </span>
    </span>
  );
}

/**
 * Chooses one quote, of any status, by searching its number, customer name or email, or the
 * customer's reference. Each result shows number, customer, total, status and valid-until, so the
 * right one can be told apart. Works by keyboard: arrows move, Enter chooses, Escape closes.
 */
export function QuoteSearchPicker({
  value,
  onSelect,
  onClear,
  label = 'Find a quote',
}: {
  value: QuoteSearchHit | null;
  onSelect: (hit: QuoteSearchHit) => void;
  onClear: () => void;
  label?: string;
}) {
  const uid = useId();
  const [term, setTerm] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<QuoteSearchHit[] | null>(null);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Searches a moment after typing stops; an answer to older input is dropped.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(() => {
      void searchSalesQuotesAction(term, status || undefined)
        .then((r) => {
          if (!live) return;
          setHits(r);
          setActive(0);
          setFailed(false);
        })
        .catch(() => live && setFailed(true));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [term, status, open]);

  // Clicking elsewhere closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const choose = (hit: QuoteSearchHit) => {
    onSelect(hit);
    setOpen(false);
    setTerm('');
  };

  if (value)
    return (
      <div className="space-y-1">
        <span className="block text-sm font-medium text-fg">{label}</span>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3">
          <div className="min-w-0 flex-1">
            <QuoteSummary hit={value} />
          </div>
          <button
            type="button"
            onClick={() => {
              onClear();
              setOpen(true);
            }}
            className="min-h-10 cursor-pointer rounded-lg border border-line px-3 text-sm text-fg hover:bg-hover"
          >
            Choose another
          </button>
        </div>
      </div>
    );

  return (
    <div ref={box} className="space-y-1">
      <label htmlFor={`${uid}-q`} className="block text-sm font-medium text-fg">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            id={`${uid}-q`}
            role="combobox"
            aria-expanded={open}
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            aria-activedescendant={open && hits?.[active] ? `${uid}-o-${active}` : undefined}
            autoComplete="off"
            value={term}
            placeholder="Quote number, customer name or email, or their reference"
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => {
              setTerm(e.target.value);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setOpen(true);
                setActive((a) => Math.min((hits?.length ?? 1) - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && open && hits?.[active]) {
                e.preventDefault();
                choose(hits[active]);
              } else if (e.key === 'Escape' && open) {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            className="min-h-10 w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong"
          />
        </div>
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOpen(true);
          }}
          className="min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
        >
          <option value="">Any status</option>
          {QUOTE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusText(s)}
            </option>
          ))}
        </select>
      </div>
      {open && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          <div
            aria-hidden
            className="hidden gap-x-3 border-b border-line bg-surface-raised px-3 py-2 text-xs font-semibold text-fg-muted sm:grid sm:grid-cols-[9rem_minmax(0,1fr)_8rem_7rem_6rem]"
          >
            <span>Quote</span>
            <span>Customer</span>
            <span className="text-right">Total</span>
            <span>Status</span>
            <span>Valid until</span>
          </div>
          <ul
            id={`${uid}-list`}
            role="listbox"
            aria-label="Quotes"
            className="max-h-72 overflow-y-auto"
          >
            {hits?.map((hit, i) => (
              <li
                key={hit.id}
                id={`${uid}-o-${i}`}
                role="option"
                aria-selected={i === active}
                className={`cursor-pointer border-b border-line/60 px-3 py-2 last:border-b-0 ${i === active ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-hover'}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(hit);
                }}
              >
                <QuoteSummary hit={hit} />
              </li>
            ))}
          </ul>
          {hits === null && !failed && (
            <p role="status" className="p-4 text-sm text-fg-muted">
              Looking…
            </p>
          )}
          {failed && (
            <p role="alert" className="p-4 text-sm text-red-700">
              Could not search quotes. Try again.
            </p>
          )}
          {hits?.length === 0 && (
            <p role="status" className="p-4 text-sm text-fg-muted">
              No quote matches. Search by number, customer name or email, or change the status.
            </p>
          )}
          {hits && hits.length >= 20 && (
            <p className="border-t border-line p-2 text-xs text-fg-muted">
              Showing the 20 most recent. Type more to narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
