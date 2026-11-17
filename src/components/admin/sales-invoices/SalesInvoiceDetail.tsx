'use client';

import { useEffect, useState } from 'react';
import { salesInvoiceDetailAction, salesInvoicePdfAction, sendSalesInvoiceAction } from '@/server/domains/selling/sales-invoice-actions';
import type { SalesInvoiceDetail as Detail } from '@/server/domains/selling/sales-invoice-service';
import { INVOICE_KIND_WORDS, PAYMENT_WORDS, SIGNING_WORDS } from '@/server/domains/selling/domain/invoice-status';
import { Chip, buttonClass } from '@/components/ui/screen-kit';
import { useWhen } from '@/components/business-time';

const money = (currency: string, amount: number): string => `${currency} ${amount.toLocaleString()}`;

/** One invoice opened: how it stands, its lines, the credit notes against it and the signing log; send it again or download it. */
export function SalesInvoiceDetail({ invoiceNumber, canSend, onSent }: { invoiceNumber: string; canSend: boolean; onSent: () => void }) {
  const when = useWhen();
  const [state, setState] = useState<{ number: string; detail: Detail | null | 'failed' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void salesInvoiceDetailAction(invoiceNumber).then((r) => {
      if (live) setState({ number: invoiceNumber, detail: r.ok ? r.data : 'failed' });
    });
    return () => {
      live = false;
    };
  }, [invoiceNumber]);

  const detail = state !== null && state.number === invoiceNumber ? state.detail : undefined;
  if (detail === undefined) return <p role="status" className="text-sm text-fg-muted">Opening the invoice…</p>;
  if (detail === 'failed') return <p role="alert" className="text-sm text-red-700">The invoice could not be loaded. Please try again.</p>;
  if (detail === null) return <p role="alert" className="text-sm text-red-700">That invoice could not be found.</p>;

  const send = async () => {
    setBusy(true);
    setMessage(null);
    const r = await sendSalesInvoiceAction(detail.orderId, detail.kind);
    setBusy(false);
    if (r.ok) {
      setMessage({ kind: 'ok', text: r.data.emailed ? `Sent ${r.data.invoiceNumber} to ${detail.customerEmail}.` : 'The invoice was made but could not be emailed.' });
      onSent();
    } else setMessage({ kind: 'error', text: r.error });
  };
  const download = async () => {
    setBusy(true);
    setMessage(null);
    const r = await salesInvoicePdfAction(detail.orderId, detail.kind);
    setBusy(false);
    if (!r.ok) {
      setMessage({ kind: 'error', text: r.error });
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

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4 text-sm" data-testid="invoice-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="sky">{INVOICE_KIND_WORDS[detail.kind] ?? detail.kind}</Chip>
        <Chip tone={SIGNING_WORDS[detail.signing].tone}>{SIGNING_WORDS[detail.signing].label}</Chip>
        <Chip tone={PAYMENT_WORDS[detail.payment].tone}>{PAYMENT_WORDS[detail.payment].label}</Chip>
        {detail.approvalStatus === 'pending' ? <Chip tone="amber">Order waiting for approval</Chip> : null}
      </div>
      <p className="text-fg-muted">For order {detail.orderNumber} ({detail.orderStatus ?? 'unknown'}), {detail.customerName} &lt;{detail.customerEmail === '' ? 'no email' : detail.customerEmail}&gt;. {detail.emailedAt === null ? 'Not emailed yet.' : `Emailed ${when(detail.emailedAt)}.`}</p>
      <div>
        <h4 className="font-semibold text-fg-strong">What was invoiced</h4>
        <ul className="mt-1 space-y-0.5">{detail.lines.map((l) => <li key={l.name + String(l.total)} className="flex justify-between gap-3"><span className="min-w-0 break-words">{l.quantity} × {l.name}</span><span className="font-mono">{money(detail.currency, l.total)}</span></li>)}</ul>
        <p className="mt-1 flex justify-between gap-3 font-semibold text-fg-strong"><span>Total</span><span className="font-mono">{money(detail.currency, detail.total)}</span></p>
      </div>
      {detail.creditNotes.length === 0 ? <p className="text-fg-muted">No credit notes against this invoice. A signed invoice is corrected by a credit note, never edited.</p> : (
        <div>
          <h4 className="font-semibold text-fg-strong">Credit notes</h4>
          <ul className="mt-1 space-y-0.5" data-testid="invoice-credit-notes">{detail.creditNotes.map((n) => <li key={n.number}>{n.number}: {money(n.currency, n.total)} ({n.kraStatus.replaceAll('_', ' ')}, {when(n.createdAt)})</li>)}</ul>
        </div>
      )}
      <details>
        <summary className="min-h-10 cursor-pointer content-center font-semibold text-fg-strong">Signing log ({detail.signingLog.length})</summary>
        {detail.signingLog.length === 0 ? <p className="mt-1 text-fg-muted">KRA signing has not looked at this invoice.</p> : <ul className="mt-1 space-y-0.5">{detail.signingLog.map((e, i) => <li key={`${e.createdAt}-${String(i)}`}>{when(e.createdAt)}: {e.eventType} {e.outcome} ({e.reason.replaceAll('_', ' ').toLowerCase()})</li>)}</ul>}
      </details>
      {message === null ? null : <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}>{message.text}</p>}
      {canSend ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={busy || detail.customerEmail === ''} onClick={() => void send()}>{busy ? 'Working…' : 'Send again by email'}</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void download()}>Download PDF</button>
        </div>
      ) : null}
    </div>
  );
}
