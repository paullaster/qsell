'use client';

import { useCallback, useEffect, useState } from 'react';
import { issuePartInvoiceAction, orderBillingViewAction, partInvoicePdfAction, previewPartInvoiceAction } from '@/server/domains/selling/partial-billing-actions';
import type { OrderBillingView } from '@/server/domains/selling/partial-billing-service';
import type { PlannedBilling } from '@/server/domains/selling/domain/partial-billing';
import { Chip, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';

const money = (currency: string, amount: number): string => `${currency} ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Invoicing part of an order: what is ordered, invoiced and left on each line, the part invoices already made, and (when the company
 * has switched it on) a part invoice for the quantities typed or for everything that is left. The server works out every amount.
 */
function PreviewLine({ shown, currency }: { shown: { plan: PlannedBilling | null; error: string | null } | null; currency: string }) {
  if (shown === null) return null;
  if (shown.plan === null) return <p role="alert" className="text-sm text-amber-700" data-testid="part-preview-problem">{shown.error}</p>;
  const extra = shown.plan.remainderCents > 0 ? ` (including ${money(currency, shown.plan.remainderCents / 100)} for delivery and the rest of the order)` : '';
  return <p className="text-sm font-semibold text-fg-strong" data-testid="part-preview">This invoice: {money(currency, shown.plan.totalCents / 100)}{extra}{shown.plan.finishesOrder ? ' · finishes the order' : ''}</p>;
}

export function PartInvoicePanel({ orderId, currency, onIssued }: { orderId: string; currency: string; onIssued: (text: string) => void }) {
  const [view, setView] = useState<OrderBillingView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ for: string; plan: PlannedBilling | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await orderBillingViewAction(orderId);
    if (!r.ok) setLoadError(r.error);
    else if (r.data === null) setLoadError('That order could not be found.');
    else {
      setLoadError(null);
      setView(r.data);
    }
  }, [orderId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount: state is set when the answer arrives
    void load();
  }, [load]);

  const asks = view === null ? [] : view.lines.flatMap((l) => (Number(counts[l.orderItemId]) > 0 ? [{ orderItemId: l.orderItemId, quantity: Number(counts[l.orderItemId]) }] : []));
  const wanted = useDebouncedValue(asks.length === 0 ? '' : JSON.stringify({ asks }), 400);
  useEffect(() => {
    if (wanted === '') return;
    let live = true;
    void previewPartInvoiceAction(orderId, JSON.parse(wanted) as unknown).then((r) => {
      if (live) setPreview(r.ok ? { for: wanted, plan: r.data, error: null } : { for: wanted, plan: null, error: r.error });
    });
    return () => {
      live = false;
    };
  }, [wanted, orderId]);
  const shown = preview !== null && preview.for === wanted && wanted !== '' ? preview : null;

  const issue = async (rest: boolean) => {
    setBusy(true);
    setProblem(null);
    const r = await issuePartInvoiceAction(orderId, rest ? { rest: true } : { asks });
    setBusy(false);
    if (r.ok) {
      setCounts({});
      setPreview(null);
      onIssued(`Part invoice ${r.data.invoiceNumber} raised${r.data.finishesOrder ? ': the order is now invoiced in full' : ''}.`);
      await load();
    } else setProblem(r.error);
  };
  const download = async (billingId: string) => {
    const r = await partInvoicePdfAction(billingId);
    if (!r.ok) {
      setProblem(r.error);
      return;
    }
    const bytes = Uint8Array.from(atob(r.data.pdfBase64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = r.data.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loadError !== null) return <p role="alert" className="text-sm text-red-700">{loadError}</p>;
  if (view === null) return <p role="status" className="text-sm text-fg-muted">Loading the order…</p>;
  if (!view.canPart && !view.canRest && view.invoices.length === 0) {
    return view.reason === null ? null : <p className="text-sm text-fg-muted" data-testid="part-invoice-reason">{view.reason}</p>;
  }
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Invoice part of this order" data-testid="part-invoice-panel">
      <h3 className="text-sm font-bold text-fg-strong">Invoicing in parts</h3>
      {view.invoices.length === 0 ? null : (
        <ul className="space-y-1 text-sm" data-testid="part-invoices">
          {view.invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="part-invoice">
              <span>Part {i.sequence}: <span className="font-semibold">{i.invoiceNumber}</span> · {money(currency, i.total)}{i.finishesOrder ? ' · finishes the order' : ''}</span>
              <span className="flex items-center gap-2"><Chip tone={i.kraStatus === 'transmitted' ? 'green' : 'gray'}>{i.kraStatus === 'transmitted' ? 'Signed' : 'Not signed yet'}</Chip><button type="button" className={buttonClass} aria-label={`Download part invoice ${i.invoiceNumber}`} onClick={() => void download(i.id)}>PDF</button></span>
            </li>
          ))}
        </ul>
      )}
      {view.reason === null ? null : <p className="text-sm text-fg-muted" data-testid="part-invoice-reason">{view.reason}</p>}
      {!view.canPart && !view.canRest ? null : (
        <>
          <ul className="space-y-2" data-testid="part-lines">
            {view.lines.map((l) => (
              <li key={l.orderItemId} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-2" data-testid="part-line">
                <span className="min-w-0 flex-1 break-words text-fg-strong">{l.description}<span className="block text-xs text-fg-muted">ordered {l.ordered} · invoiced {l.invoiced} · left {l.left} · {money(currency, l.unitPrice)} each</span></span>
                {view.canPart && l.left > 0 ? <input aria-label={`Quantity of ${l.description} to invoice`} type="number" inputMode="decimal" min={0} max={l.left} step="any" className={`${fieldClass} w-24`} value={counts[l.orderItemId] ?? ''} onChange={(e) => setCounts((c) => ({ ...c, [l.orderItemId]: e.target.value }))} /> : null}
              </li>
            ))}
          </ul>
          <PreviewLine shown={shown} currency={currency} />
          {problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="part-problem">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            {view.canPart ? <button type="button" className={primaryClass} disabled={busy || asks.length === 0 || shown?.plan === null || shown === null} onClick={() => void issue(false)}>{busy ? 'Working…' : 'Invoice these quantities'}</button> : null}
            {view.canRest ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void issue(true)}>Invoice what is left</button> : null}
          </div>
        </>
      )}
    </section>
  );
}
