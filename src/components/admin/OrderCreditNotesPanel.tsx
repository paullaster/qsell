'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  getOrderCreditableAction,
  issueOrderCreditNoteAction,
  listOrderCreditNotesAction,
  retryCreditNoteSigningAction,
  type CreditNoteView,
} from '@/server/domains/credit-notes/actions';
import { CREDIT_NOTE_REASONS, type CreditNoteReason } from '@/server/domains/credit-notes/reasons';

type Creditable = NonNullable<
  Awaited<ReturnType<typeof getOrderCreditableAction>> extends infer R
    ? R extends { ok: true; data: infer D }
      ? D
      : never
    : never
>;

const REASON_LABEL: Record<CreditNoteReason, string> = {
  returned_goods: 'Goods returned',
  damaged_goods: 'Damaged goods',
  pricing_error: 'Pricing error',
  order_cancelled: 'Order cancelled',
  goodwill: 'Goodwill',
  other: 'Other (explain below)',
};

const STATUS: Record<string, { label: string; style: string }> = {
  transmitted: {
    label: 'Signed with KRA',
    style: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700',
  },
  skipped: { label: 'Not signed', style: 'border-line bg-surface-sunken text-fg-muted' },
  failed: { label: 'Signing failed', style: 'border-red-500/20 bg-red-500/10 text-red-700' },
  deferred: {
    label: 'Waiting for the invoice to be signed',
    style: 'border-amber-500/20 bg-amber-500/10 text-amber-700',
  },
  pending: { label: 'Signing…', style: 'border-amber-500/20 bg-amber-500/10 text-amber-700' },
};

const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none';
const buttonClass =
  'min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg hover:bg-hover disabled:opacity-50';
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number, currency: string) =>
  `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Credit notes for one order: what exists, and a form to issue another against the order's
 * tax invoice. Hidden entirely for people without the credit-note permission.
 */
export function OrderCreditNotesPanel({ orderId }: { orderId: string }) {
  const uid = useId();
  const [data, setData] = useState<Creditable | null>(null);
  const [notes, setNotes] = useState<CreditNoteView[]>([]);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<CreditNoteReason>('returned_goods');
  const [note, setNote] = useState('');
  const [restock, setRestock] = useState(false);
  // Plain busy state, deliberately not a transition: the actions revalidate the orders page,
  // and a transition would keep the buttons disabled until that refresh lands.
  const [issuing, setIssuing] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  // The order this panel is showing right now, and follow-up refreshes still waiting to run.
  // Both exist so a slow response or a timer from a previous order can never write its data
  // into the panel after another order has been opened.
  const currentOrder = useRef(orderId);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const load = useCallback(async () => {
    const [c, n] = await Promise.all([
      getOrderCreditableAction(orderId),
      listOrderCreditNotesAction(orderId),
    ]);
    if (currentOrder.current !== orderId) return;
    if ((!c.ok && c.forbidden) || (!n.ok && n.forbidden)) return setHidden(true);
    if (c.ok) setData(c.data);
    else setError(c.error);
    if (n.ok) setNotes(n.data);
  }, [orderId]);

  useEffect(() => {
    currentOrder.current = orderId;
    const waiting = timers.current;
    setData(null);
    setNotes([]);
    setOpen(false);
    setError(null);
    setNotice(null);
    setQty({});
    void load();
    return () => {
      for (const t of waiting) clearTimeout(t);
      waiting.length = 0;
    };
  }, [load, orderId]);

  const lines = data?.lines ?? [];
  const anythingLeft = lines.some((l) => l.remainingQuantity > 0);
  const chosen = useMemo(
    () =>
      lines
        .map((l) => ({ line: l, quantity: Math.floor(Number(qty[l.productId] ?? 0)) }))
        .filter((x) => x.quantity > 0),
    [lines, qty],
  );
  const estimate = round2(
    chosen.reduce(
      (sum, { line, quantity }) =>
        // The last unit takes whatever is left, exactly as the server prices it.
        sum +
        (quantity === line.remainingQuantity
          ? line.remainingAmount
          : round2(line.unitPrice * quantity)),
      0,
    ),
  );
  const noteMissing = reason === 'other' && note.trim() === '';

  if (hidden) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void (async () => {
      setIssuing(true);
      setError(null);
      setNotice(null);
      try {
        const res = await issueOrderCreditNoteAction({
          orderId,
          lines: chosen.map(({ line, quantity }) => ({ productId: line.productId, quantity })),
          reasonCode: reason,
          reasonNote: note.trim() || undefined,
          restock: restock && data?.canRestock,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setNotice(
          `Credit note ${res.data.creditNoteNo} issued. Signing with KRA continues in the background.`,
        );
        setOpen(false);
        setQty({});
        setNote('');
        setRestock(false);
        await load();
        // The signing result arrives a moment later; look again.
        timers.current.push(
          setTimeout(() => void load(), 2500),
          setTimeout(() => void load(), 7000),
        );
      } finally {
        setIssuing(false);
      }
    })();
  };

  const retry = (id: string) => {
    void (async () => {
      setRetrying(id);
      setError(null);
      try {
        const res = await retryCreditNoteSigningAction(id);
        if (!res.ok) setError(res.error);
        await load();
      } finally {
        setRetrying(null);
      }
    })();
  };

  return (
    <section
      aria-labelledby={`${uid}-h`}
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`${uid}-h`} className="text-xs font-bold tracking-wider text-fg-strong uppercase">
          Credit notes
        </h4>
        {data?.hasTaxInvoice && anythingLeft && !open ? (
          <button type="button" className={buttonClass} onClick={() => setOpen(true)}>
            Issue credit note
          </button>
        ) : null}
      </div>

      <div aria-live="polite" className="space-y-1">
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-red-700"
          >
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-emerald-700">
            {notice}
          </p>
        ) : null}
      </div>

      {data && !data.hasTaxInvoice ? (
        <p className="text-fg-muted">
          A credit note reverses a tax invoice. Generate this order&apos;s tax invoice first.
        </p>
      ) : null}

      {data?.hasTaxInvoice && !anythingLeft ? (
        <p className="text-fg-muted">Everything on this invoice has been credited.</p>
      ) : null}

      {notes.length > 0 ? (
        <ul className="divide-y divide-line/60">
          {notes.map((n) => {
            const status = STATUS[n.kraStatus] ?? STATUS.pending!;
            return (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-mono font-semibold text-fg-strong">{n.creditNoteNo}</span>{' '}
                  <span className="text-fg-muted">
                    {money(n.totalAmount, n.currency)} ·{' '}
                    {REASON_LABEL[n.reasonCode as CreditNoteReason] ?? n.reasonCode}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status.style}`}
                  >
                    {status.label}
                  </span>
                  {n.kraStatus === 'failed' || n.kraStatus === 'deferred' ? (
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={retrying === n.id}
                      onClick={() => retry(n.id)}
                    >
                      Retry signing
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : data?.hasTaxInvoice ? (
        <p className="text-fg-muted">No credit notes yet.</p>
      ) : null}

      {open && data ? (
        <form
          onSubmit={submit}
          className="space-y-4 border-t border-line pt-4"
          aria-label="Issue credit note"
        >
          <p className="text-fg-muted">
            Invoice total {money(data.invoiceTotal, data.currency)}; already credited{' '}
            {money(data.creditedTotal, data.currency)}. Lines are credited at the price they were
            sold at.
          </p>
          <div className="space-y-2">
            {lines.map((l) => (
              <div
                key={l.productId}
                className="grid grid-cols-1 items-center gap-2 rounded-lg bg-surface-sunken/60 p-3 sm:grid-cols-[1fr_auto]"
              >
                <div>
                  <p className="font-semibold text-fg-strong">{l.description}</p>
                  <p className="text-fg-muted">
                    {l.soldQuantity} sold · {l.creditedQuantity} credited · {l.remainingQuantity}{' '}
                    left @ {money(l.unitPrice, data.currency)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor={`${uid}-q-${l.productId}`} className="text-fg-muted">
                    Credit
                  </label>
                  <input
                    id={`${uid}-q-${l.productId}`}
                    type="number"
                    min={0}
                    max={l.remainingQuantity}
                    step={1}
                    disabled={l.remainingQuantity === 0}
                    value={qty[l.productId] ?? ''}
                    placeholder="0"
                    onChange={(e) => setQty((p) => ({ ...p, [l.productId]: e.target.value }))}
                    className={`${fieldClass} w-24`}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-r`} className="mb-1 block font-semibold text-fg">
                Reason
              </label>
              <select
                id={`${uid}-r`}
                value={reason}
                onChange={(e) => setReason(e.target.value as CreditNoteReason)}
                className={fieldClass}
              >
                {CREDIT_NOTE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-n`} className="mb-1 block font-semibold text-fg">
                Note{reason === 'other' ? ' (required)' : ''}
              </label>
              <input
                id={`${uid}-n`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className={fieldClass}
                required={reason === 'other'}
              />
            </div>
          </div>

          <div>
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-fg">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={restock && data.canRestock}
                disabled={!data.canRestock}
                onChange={(e) => setRestock(e.target.checked)}
              />
              Return the credited units to stock
            </label>
            {!data.canRestock ? (
              <p className="text-fg-muted">
                Not available: stock was never taken for this order (it has not been fulfilled). To
                release its reserved stock, cancel the order instead.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-semibold text-fg-strong">
              Credit total: {money(estimate, data.currency)}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className={buttonClass}
                onClick={() => setOpen(false)}
                disabled={issuing}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={issuing || chosen.length === 0 || noteMissing}
                className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {issuing ? 'Issuing…' : 'Issue credit note'}
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </section>
  );
}
