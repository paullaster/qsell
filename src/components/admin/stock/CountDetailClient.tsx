'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  approveStockCountAction,
  cancelStockCountAction,
  postStockCountAction,
  recordStockCountAction,
  reopenStockCountAction,
  submitStockCountAction,
  type stockCountAction,
  type CountDetail,
} from '@/server/domains/stock/count-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, LoadFailed, Message, PageHeader, Chip, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { COUNT_STATE_WORDS, isCountState } from '@/lib/stock-documents';
import type { Choice } from '@/lib/payment-options';

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });
const signed = (n: number): string => (n > 0 ? `+${String(n)}` : String(n));

export function CountDetailClient({ viewPromise }: { viewPromise: ReturnType<typeof stockCountAction> }) {
  const res = use(viewPromise);
  return res.ok ? <Detail c={res.data} /> : <LoadFailed error={res.error} />;
}

function Detail({ c }: { c: CountDetail }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reason, setReason] = useState('');
  // What is typed per product; only a figure that differs from the saved one is sent, so saving again does not re-stamp a line.
  const [typed, setTyped] = useState<Record<string, string>>(() => Object.fromEntries(c.lines.map((l) => [l.productId, l.counted === null ? '' : String(l.counted)])));
  const [extra, setExtra] = useState<Choice | null>(null);
  const [extraQuantity, setExtraQuantity] = useState('');

  const words = isCountState(c.state) ? COUNT_STATE_WORDS[c.state] : { label: c.state, tone: 'gray' as const };
  const counting = c.state === 'counting';
  const review = c.state === 'counted' || c.state === 'approved';
  const open = counting || review;

  const run = async (call: Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (res.ok) {
      setNotice({ kind: 'ok', text: success });
      router.refresh();
    } else {
      setNotice({ kind: 'error', text: res.error ?? 'Something went wrong. Please try again.' });
    }
  };
  const changed = c.lines.flatMap((l) => {
    const text = (typed[l.productId] ?? '').trim();
    const saved = l.counted === null ? '' : String(l.counted);
    return text === saved || text === '' ? [] : [{ productId: l.productId, quantity: Number(text) }];
  });

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`Count ${c.number}`}
        intro={
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={words.tone}>{words.label}</Chip>
            <span>
              {c.location.code} · {c.location.name} · {c.mode === 'full' ? 'full count' : 'cycle count'}
              {c.blind ? ', blind' : ''}
            </span>
          </span>
        }
        actions={
          <Link href="/admin/inventory/counts" className={buttonClass}>
            All counts
          </Link>
        }
      />
      <Message notice={notice} />
      {c.note === '' ? null : <p className="text-sm text-fg">{c.note}</p>}
      {c.blind && counting && c.lines.every((l) => l.expected === null) ? <p className="text-sm text-fg-muted">This is a blind count: what each product should hold is not shown while you count.</p> : null}

      <ul className="space-y-2" aria-label="Products in the count">
        {c.lines.map((l) => (
          <li key={l.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold break-words text-fg-strong">{l.productName}</p>
                <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
                  {l.expected === null ? null : <span>Should hold {l.expected}</span>}
                  {l.movedSince === null || l.movedSince === 0 ? null : <span>Moved meanwhile {signed(l.movedSince)}</span>}
                  {l.countedAt === null ? null : (
                    <span>
                      Counted by {l.countedByName ?? 'someone'} at <time dateTime={l.countedAt}>{when(l.countedAt)}</time>
                    </span>
                  )}
                </p>
              </div>
              {counting ? (
                <div className="w-32">
                  <label htmlFor={`${uid}-q-${l.id}`} className="sr-only">
                    {`Counted: ${l.productName}`}
                  </label>
                  <input
                    id={`${uid}-q-${l.id}`}
                    inputMode="decimal"
                    value={typed[l.productId] ?? ''}
                    onChange={(e) => setTyped((q) => ({ ...q, [l.productId]: e.target.value }))}
                    className={`${fieldClass} min-h-12 text-lg`}
                    autoComplete="off"
                    placeholder="Counted"
                  />
                </div>
              ) : (
                <div className="text-right text-sm">
                  <p className="font-semibold text-fg-strong">{l.counted === null ? 'Not counted' : `Counted ${String(l.counted)}`}</p>
                  {l.variance === null ? null : <p className={l.variance === 0 ? 'text-fg-muted' : 'font-semibold text-amber-700'}>{l.variance === 0 ? 'No difference' : `Difference ${signed(l.variance)}`}</p>}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {counting && c.may.count ? (
        <section className={`${cardClass} space-y-3`} aria-label="Enter the count">
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryClass} disabled={busy || changed.length === 0} onClick={() => void run(recordStockCountAction(c.id, changed), 'Saved the figures you entered.')}>
              {changed.length === 0 ? 'Save counted figures' : `Save ${String(changed.length)} counted ${changed.length === 1 ? 'figure' : 'figures'}`}
            </button>
            <button type="button" className={buttonClass} disabled={busy || changed.length > 0} onClick={() => void run(submitStockCountAction(c.id), 'Handed in. The differences are shown below.')}>
              Hand the count in
            </button>
          </div>
          {changed.length > 0 ? <p className="text-xs text-fg-muted">Save the figures you entered before handing the count in.</p> : null}
          <fieldset className="space-y-2 border-t border-line pt-3">
            <legend className="text-xs font-semibold text-fg">Found something that is not on the list?</legend>
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-end gap-2">
              <ChoicePicker label="Another product" source="stock-products" choice={extra} onChoice={setExtra} placeholder="Search a product by name or SKU" />
              <Field id={`${uid}-extra`} label="Counted">
                <input id={`${uid}-extra`} inputMode="decimal" value={extraQuantity} onChange={(e) => setExtraQuantity(e.target.value)} className={fieldClass} autoComplete="off" />
              </Field>
            </div>
            <button
              type="button"
              className={buttonClass}
              disabled={busy || extra === null || extraQuantity.trim() === ''}
              onClick={() => void run(recordStockCountAction(c.id, [{ productId: extra?.id ?? '', quantity: Number(extraQuantity.trim()) }]), 'Added to the count.')}
            >
              Add to the count
            </button>
          </fieldset>
        </section>
      ) : null}

      {review ? (
        <section className={`${cardClass} space-y-3`} aria-label="Review the differences">
          <p className="text-sm text-fg">
            The differences are worth <strong>{c.varianceValue.toFixed(2)}</strong>.{' '}
            {c.needsApproval && c.state === 'counted' ? 'That is more than can be posted without a second person agreeing, who took no part in the count.' : 'Posting changes the stock to what was counted.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {c.needsApproval && c.state === 'counted' && c.may.approve ? (
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void run(approveStockCountAction(c.id), 'Approved.')}>
                Approve the differences
              </button>
            ) : null}
            {c.may.approve && !(c.needsApproval && c.state === 'counted') ? (
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void run(postStockCountAction(c.id), 'Posted. The stock now matches the count.')}>
                Post the count
              </button>
            ) : null}
            {c.may.count && c.state === 'counted' ? (
              <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(reopenStockCountAction(c.id), 'Sent back to counting.')}>
                Send back to counting
              </button>
            ) : null}
          </div>
          {c.may.approve ? null : <p className="text-xs text-fg-muted">Someone who may approve counts posts it.</p>}
        </section>
      ) : null}

      {open && c.may.count ? (
        <section className={`${cardClass} space-y-2`} aria-label="Cancel the count">
          <Field id={`${uid}-cancel`} label="Cancel this count" hint="Say why. Nothing changes in the stock.">
            <input id={`${uid}-cancel`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} autoComplete="off" maxLength={300} />
          </Field>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(cancelStockCountAction(c.id, reason), 'Cancelled.')}>
            Cancel the count
          </button>
        </section>
      ) : null}
      {c.state === 'cancelled' && c.cancelReason !== null ? <p className="text-sm text-fg-muted">Cancelled: {c.cancelReason}</p> : null}

      <section aria-label="History" className="space-y-2">
        <h3 className="text-sm font-bold text-fg-strong">History</h3>
        <ol className="space-y-1.5">
          {c.steps.map((s) => (
            <li key={`${s.at}-${s.what}`} className="rounded-lg border border-line px-3 py-2 text-xs text-fg">
              <span className="font-semibold">{s.what}</span> by {s.by} · <time dateTime={s.at}>{when(s.at)}</time>
              {s.reason === null ? null : <span className="block text-fg-muted">{s.reason}</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
