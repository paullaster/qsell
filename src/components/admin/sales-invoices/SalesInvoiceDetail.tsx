'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, ExternalLink, Mail } from 'lucide-react';
import { partInvoicePdfAction } from '@/server/domains/selling/partial-billing-actions';
import { salesInvoiceDetailAction, salesInvoicePdfAction, sendSalesInvoiceAction } from '@/server/domains/selling/sales-invoice-actions';
import type { SalesInvoiceDetail as Detail } from '@/server/domains/selling/sales-invoice-service';
import type { InvoiceLine } from '@/server/domains/selling/domain/invoice-figures';
import { INVOICE_KIND_WORDS, PAYMENT_WORDS, SIGNING_WORDS } from '@/server/domains/selling/domain/invoice-status';
import { Modal } from '@/components/ui/Modal';
import { Chip, buttonClass, primaryClass } from '@/components/ui/screen-kit';
import { orderHref } from '@/lib/order-links';
import { useWhen } from '@/components/business-time';

const moneyIn = (currency: string) => (amount: number): string => new Intl.NumberFormat('en-KE', { style: 'currency', currency, currencyDisplay: 'code' }).format(amount);
const count = (n: number): string => n.toLocaleString('en-KE', { maximumFractionDigits: 3 });

/** What to say while the invoice is not on screen: it is opening, it could not be read, or it is not there. */
function whyNotShown(detail: undefined | null | 'failed'): string {
  if (detail === undefined) return 'Opening the invoice…';
  return detail === null ? 'That invoice could not be found.' : 'The invoice could not be loaded. Please try again.';
}

/** One figure of the strip at the top of an invoice: what it is, and how much. */
function Tile({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'owed' }) {
  const colour = { good: 'text-emerald-700', owed: 'text-red-700', plain: 'text-fg-strong' }[tone ?? 'plain'];
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <p className="text-xs font-semibold tracking-wider text-fg-subtle uppercase">{label}</p>
      <p className={`font-mono text-xl font-bold tabular-nums ${colour}`}>{value}</p>
    </div>
  );
}

const labelClass = 'text-xs font-semibold text-fg-subtle xl:sr-only';

/** The lines of an invoice as a table: item, quantity, unit price, discount, tax and line total, each named. Cards with the same names on a smaller screen. */
function Lines({ lines, money }: { lines: readonly InvoiceLine[]; money: (n: number) => string }) {
  const hasDiscount = lines.some((l) => l.discount > 0);
  const hasTax = lines.some((l) => l.taxRate !== null);
  const head = 'xl:bg-surface-sunken xl:px-3 xl:py-2 xl:text-xs xl:font-bold xl:tracking-wider xl:text-fg-subtle xl:uppercase';
  const cell = 'min-w-0 xl:table-cell xl:px-3 xl:py-2.5 xl:align-middle';
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <table className="block w-full xl:table xl:table-fixed" aria-label="What was invoiced">
        <thead className="hidden xl:table-header-group">
          <tr>
            <th scope="col" className={`${head} text-left`}>Item</th>
            <th scope="col" className={`${head} w-28 text-right`}>Quantity</th>
            <th scope="col" className={`${head} w-40 text-right`}>Unit price</th>
            {hasDiscount ? <th scope="col" className={`${head} w-36 text-right`}>Discount</th> : null}
            {hasTax ? <th scope="col" className={`${head} w-24 text-right`}>Tax</th> : null}
            <th scope="col" className={`${head} w-40 text-right`}>Line total</th>
          </tr>
        </thead>
        <tbody className="block xl:table-row-group">
          {lines.map((l, i) => (
            // eslint-disable-next-line react/no-array-index-key -- lines can repeat a product at different prices; the order is fixed
            <tr key={i} className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-line p-3 last:border-b-0 xl:table-row xl:p-0" data-testid="invoice-line">
              <td className={`col-span-2 ${cell}`}>
                <p className="font-semibold break-words text-fg-strong">{l.name}</p>
                {l.sku === null || l.sku === '' ? null : <p className="font-mono text-xs text-fg-muted">{l.sku}</p>}
              </td>
              <td className={cell}>
                <span className={labelClass}>Quantity</span>
                <p className="font-mono tabular-nums xl:text-right">{count(l.quantity)}{l.unitCode === null || l.unitCode === '' ? '' : ` ${l.unitCode}`}</p>
              </td>
              <td className={cell}>
                <span className={labelClass}>Unit price</span>
                <p className="font-mono tabular-nums xl:text-right">
                  {l.listUnitPrice === null ? null : <span className="block text-xs text-fg-muted line-through">{money(l.listUnitPrice)}</span>}
                  {money(l.unitPrice)}
                </p>
              </td>
              {hasDiscount ? (
                <td className={cell}>
                  <span className={labelClass}>Discount</span>
                  <p className={`font-mono tabular-nums xl:text-right ${l.discount > 0 ? 'text-emerald-700' : 'text-fg-muted'}`}>{l.discount > 0 ? `−${money(l.discount)}` : '—'}</p>
                </td>
              ) : null}
              {hasTax ? (
                <td className={cell}>
                  <span className={labelClass}>Tax</span>
                  <p className="font-mono tabular-nums xl:text-right">{l.taxRate === null ? '—' : `${count(l.taxRate)}%`}</p>
                </td>
              ) : null}
              <td className={cell}>
                <span className={labelClass}>Line total</span>
                <p className="font-mono font-bold tabular-nums text-fg-strong xl:text-right">{money(l.total)}</p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The sums under the lines, ending in what is still owed. */
function Totals({ detail, money }: { detail: Detail; money: (n: number) => string }) {
  const credited = detail.creditNotes.reduce((sum, n) => sum + n.total, 0);
  const row = 'flex items-baseline justify-between gap-6';
  return (
    <dl className="ml-auto w-full max-w-sm space-y-1.5 rounded-xl border border-line bg-surface p-4" data-testid="invoice-totals">
      {detail.figures === null ? null : (
        <>
          <div className={row}><dt className="text-fg-muted">Before tax</dt><dd className="font-mono tabular-nums">{money(detail.figures.subtotal)}</dd></div>
          {detail.figures.delivery > 0 ? <div className={row}><dt className="text-fg-muted">Delivery</dt><dd className="font-mono tabular-nums">{money(detail.figures.delivery)}</dd></div> : null}
          <div className={row}><dt className="text-fg-muted">Tax</dt><dd className="font-mono tabular-nums">{money(detail.figures.tax)}</dd></div>
        </>
      )}
      <div className={`${row} border-t border-line pt-1.5 text-base font-bold text-fg-strong`}><dt>Total</dt><dd className="font-mono tabular-nums" data-testid="invoice-total">{money(detail.total)}</dd></div>
      {detail.figures !== null && detail.figures.discount > 0 ? <div className={`${row} text-emerald-700`}><dt>Discount already taken off</dt><dd className="font-mono tabular-nums">{money(detail.figures.discount)}</dd></div> : null}
      {credited > 0 ? <div className={row}><dt className="text-fg-muted">Credit notes</dt><dd className="font-mono tabular-nums">−{money(credited)}</dd></div> : null}
      {detail.paid === null || detail.paid <= 0 ? null : <div className={row}><dt className="text-fg-muted">Paid</dt><dd className="font-mono tabular-nums">−{money(detail.paid)}</dd></div>}
      {detail.balance === null ? null : <div className={`${row} border-t border-line pt-1.5 text-base font-bold ${detail.balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}><dt>Balance due</dt><dd className="font-mono tabular-nums" data-testid="invoice-balance">{money(detail.balance)}</dd></div>}
    </dl>
  );
}

/** One invoice opened as the document it is: who it is for, where it stands, what was invoiced line by line, the sums, the credit notes against it and the signing log; send it again or download it. */
export function SalesInvoiceDetail({ invoiceNumber, canSend, onSent, onClose }: { invoiceNumber: string; canSend: boolean; onSent: () => void; onClose: () => void }) {
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
  if (detail === undefined || detail === 'failed' || detail === null) {
    return <Modal title={`Invoice ${invoiceNumber}`} onClose={onClose} extraWide><p role={detail === undefined ? 'status' : 'alert'} className="text-sm text-fg-muted">{whyNotShown(detail)}</p></Modal>;
  }

  const money = moneyIn(detail.currency);
  const credited = detail.creditNotes.reduce((sum, n) => sum + n.total, 0);
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
    const r = detail.kind === 'tax_invoice_part' ? await partInvoicePdfAction(detail.billingId) : await salesInvoicePdfAction(detail.orderId, detail.kind);
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
    <Modal title={`${INVOICE_KIND_WORDS[detail.kind] ?? detail.kind} ${detail.invoiceNumber}`} onClose={onClose} extraWide>
      <div className="space-y-5 text-sm" data-testid="invoice-detail">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="text-base font-bold break-words text-fg-strong">{detail.customerName}</p>
            <p className="break-words text-fg-muted">{detail.customerEmail === '' ? 'No email on file' : detail.customerEmail}</p>
            <p className="text-fg-muted">Issued {when(detail.createdAt)} · {detail.emailedAt === null ? 'Not emailed yet.' : `Emailed ${when(detail.emailedAt)}.`}</p>
            <p><Link href={orderHref(detail.orderId)} className="inline-flex min-h-10 items-center gap-1 font-semibold text-indigo-600 hover:underline">Open order {detail.orderNumber}<ExternalLink className="h-3.5 w-3.5" aria-hidden /></Link> <span className="text-fg-muted">({detail.orderStatus ?? 'unknown'}{detail.salesModule === 'sales_invoice' ? ', direct sale' : ''})</span></p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="sky">{INVOICE_KIND_WORDS[detail.kind] ?? detail.kind}</Chip>
            <Chip tone={SIGNING_WORDS[detail.signing].tone}>{SIGNING_WORDS[detail.signing].label}</Chip>
            <Chip tone={PAYMENT_WORDS[detail.payment].tone}>{PAYMENT_WORDS[detail.payment].label}</Chip>
            {detail.approvalStatus === 'pending' ? <Chip tone="amber">Order waiting for approval</Chip> : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="invoice-summary">
          <Tile label="Invoice total" value={money(detail.total)} />
          {credited > 0 ? <Tile label="Credited" value={money(credited)} /> : null}
          {detail.paid === null ? null : <Tile label="Paid" value={money(detail.paid)} tone={detail.paid > 0 ? 'good' : undefined} />}
          {detail.balance === null ? null : <Tile label="Balance due" value={money(detail.balance)} tone={detail.balance > 0 ? 'owed' : 'good'} />}
        </div>

        <section className="space-y-3" aria-label="What was invoiced">
          <h3 className="text-base font-bold text-fg-strong">What was invoiced</h3>
          <Lines lines={detail.lines} money={money} />
          <Totals detail={detail} money={money} />
        </section>

        {detail.creditNotes.length === 0 ? <p className="text-fg-muted">No credit notes against this invoice. A signed invoice is corrected by a credit note, never edited.</p> : (
          <section className="space-y-2" aria-label="Credit notes">
            <h3 className="text-base font-bold text-fg-strong">Credit notes</h3>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface" data-testid="invoice-credit-notes">
              {detail.creditNotes.map((n) => (
                <li key={n.number} className="flex flex-wrap items-baseline justify-between gap-2 p-3">
                  <span className="font-semibold text-fg-strong">{n.number}</span>
                  <span className="text-fg-muted">{n.kraStatus.replaceAll('_', ' ')} · {when(n.createdAt)}</span>
                  <span className="font-mono font-bold tabular-nums">{moneyIn(n.currency)(n.total)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <details>
          <summary className="min-h-10 cursor-pointer content-center font-semibold text-fg-strong">Signing log ({detail.signingLog.length})</summary>
          {detail.signingLog.length === 0 ? <p className="mt-1 text-fg-muted">KRA signing has not looked at this invoice.</p> : <ul className="mt-1 space-y-0.5">{detail.signingLog.map((e, i) => <li key={`${e.createdAt}-${String(i)}`}>{when(e.createdAt)}: {e.eventType} {e.outcome} ({e.reason.replaceAll('_', ' ').toLowerCase()})</li>)}</ul>}
        </details>

        <div className="sticky bottom-0 -mx-4 -mb-4 space-y-2 border-t border-line bg-surface-raised/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6">
          {message === null ? null : <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}>{message.text}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {canSend ? <button type="button" className={`${primaryClass} min-h-11 gap-1`} disabled={busy} onClick={() => void download()}><Download className="h-4 w-4" aria-hidden />Download PDF</button> : null}
            {canSend && detail.kind !== 'tax_invoice_part' ? <button type="button" className={`${buttonClass} min-h-11 gap-1`} disabled={busy || detail.customerEmail === ''} onClick={() => void send()}><Mail className="h-4 w-4" aria-hidden />{busy ? 'Working…' : 'Send again by email'}</button> : null}
            <button type="button" className={`${buttonClass} ml-auto min-h-11`} onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
