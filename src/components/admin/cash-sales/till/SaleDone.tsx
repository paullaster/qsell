'use client';

import { CheckCircle2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useWhen } from '@/components/business-time';
import { Modal } from '@/components/ui/Modal';
import type { SaleSummary } from '@/server/domains/selling/cash-sales/cash-sale-service';
import { orElse } from '@/lib/values';
import { kes } from '@/lib/till/tile-style';

/** After the sale: the receipt, the change to give in large figures, print, and the next sale one press away. */
export function SaleDone({ sale, shopName, onClose }: { sale: SaleSummary; shopName: string; onClose: () => void }) {
  return (
    <Modal title="Sale complete" onClose={onClose}>
      <section aria-label="Receipt" data-testid="receipt" className="space-y-4">
        <div className="flex items-center gap-3 rounded-2xl bg-emerald-600/10 p-4 text-emerald-700">
          <CheckCircle2 className="size-10 shrink-0" aria-hidden />
          <div>
            <p className="text-sm font-semibold">Change to give</p>
            <p className="font-mono text-4xl font-bold" data-testid="receipt-change">{kes(sale.changeDue)}</p>
          </div>
        </div>
        <div className="space-y-1 text-sm">
          <h2 className="text-base font-bold text-fg-strong">Receipt {orElse(sale.receiptNumber, '(being made)')}</h2>
          <p className="text-fg-muted">Sale {sale.orderNumber} · {sale.customerName}</p>
        </div>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-3 text-base font-bold text-fg-strong"><dt>Total</dt><dd className="font-mono">{kes(sale.total)}</dd></div>
          {sale.tenders.map((t) => (
            <div key={t.label + t.kind + String(t.applied)} className="flex justify-between gap-3"><dt>{t.label}{t.reference === null ? '' : ` (${t.reference})`}</dt><dd className="font-mono">{kes(t.applied)}</dd></div>
          ))}
        </dl>
        {sale.warning === undefined ? null : <p role="alert" className="text-sm text-amber-700">{sale.warning}</p>}
        <PrintedReceipt sale={sale} shopName={shopName} />
        <div className="flex flex-wrap gap-2 print:hidden">
          <button type="button" className="inline-flex min-h-12 cursor-pointer items-center rounded-xl border border-line px-5 text-sm font-semibold text-fg hover:bg-hover" onClick={() => window.print()}>Print receipt</button>
          <button type="button" autoFocus className="inline-flex min-h-12 flex-1 cursor-pointer items-center justify-center rounded-xl bg-indigo-600 px-5 text-base font-bold text-white hover:bg-indigo-500" onClick={onClose} data-testid="new-sale">New sale</button>
        </div>
      </section>
    </Modal>
  );
}

/** What the printer is given: only this (the page and the dialog are left out), on 80 mm till paper, without the browser's own header and footer. */
const RECEIPT_CSS = `
@page { size: 80mm auto; margin: 0; }
.receipt-print { display: none; }
@media print {
  body > *:not(.receipt-print) { display: none !important; }
  .receipt-print { display: block; width: 72mm; margin: 0 auto; padding: 4mm 0; color: #000; background: #fff; font: 12px/1.35 ui-monospace, 'Courier New', monospace; }
  .receipt-print h1 { margin: 0; font-size: 16px; text-align: center; }
  .receipt-print p { margin: 0; }
  .receipt-print .c { text-align: center; }
  .receipt-print hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .receipt-print .row { display: flex; justify-content: space-between; gap: 8px; }
  .receipt-print .big { font-size: 14px; font-weight: 700; }
}`;

function PrintedReceipt({ sale, shopName }: { sale: SaleSummary; shopName: string }) {
  const when = useWhen();
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="receipt-print" data-testid="receipt-print" aria-hidden>
      <style>{RECEIPT_CSS}</style>
      <h1>{shopName}</h1>
      <p className="c">Receipt {orElse(sale.receiptNumber, sale.orderNumber)}</p>
      <p className="c">{when(sale.at)}</p>
      <hr />
      {sale.lines.map((l, i) => (
        // eslint-disable-next-line react/no-array-index-key -- lines can repeat a product at different prices; the order is fixed
        <div key={i}>
          <p>{l.name}</p>
          <div className="row"><span>{l.quantity} x {kes(l.unitPrice)}</span><span>{kes(l.total)}</span></div>
        </div>
      ))}
      <hr />
      <div className="row big"><span>TOTAL</span><span>{kes(sale.total)}</span></div>
      {sale.tenders.map((t) => (
        <div key={t.label + t.kind + String(t.applied)} className="row"><span>{t.label}{t.reference === null ? '' : ` ${t.reference}`}</span><span>{kes(t.handedOver ?? t.applied)}</span></div>
      ))}
      {sale.changeDue > 0 ? <div className="row big"><span>CHANGE</span><span>{kes(sale.changeDue)}</span></div> : null}
      <hr />
      <p className="c">Customer: {sale.customerName}</p>
      <p className="c">Thank you</p>
    </div>,
    document.body,
  );
}
