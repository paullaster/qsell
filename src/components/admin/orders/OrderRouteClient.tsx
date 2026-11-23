'use client';

import { use, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { generateInvoicePdfAction, emailInvoiceAction } from '@/server/domains/invoices/actions';
import { updateOrderStatusAction, cancelOrderAction } from '@/server/actions';
import { downloadPdfBase64 } from '@/lib/downloadPdf';
import { invoiceHref, orderChannel, orderHref } from '@/lib/order-links';
import { announceOrdersChanged } from '@/lib/orders-changed';
import type { PublicCompany } from '@/lib/company-view';
import type { Order } from '@/types/index';
import { OrderDetailsModal, type FulfilmentChange } from './OrderDetailsModal';
import { OrderInvoicePreview } from './OrderInvoicePreview';
import { Modal } from '@/components/ui/Modal';

const messageOf = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

/**
 * One order opened for work, from whichever screen the person was on. Reached from a link inside the admin it opens over that screen and
 * closing it goes back there; reached by its own address (a pasted link, a reload) it is a page with a way back to the screen it belongs to.
 */
export function OrderRouteClient({
  orderPromise,
  companyPromise,
  canEditProductsPromise,
  presentation,
}: {
  orderPromise: Promise<Order | null>;
  companyPromise: Promise<PublicCompany>;
  canEditProductsPromise: Promise<boolean>;
  presentation: 'modal' | 'page';
}) {
  const router = useRouter();
  // Whether the invoice preview is open is read from the address, so it is still open (or still closed) when the person comes back to this order from another window.
  const asked = useSearchParams().get('invoice') === '1';
  const first = use(orderPromise);
  const company = use(companyPromise);
  const canEditProducts = use(canEditProductsPromise);
  const [order, setOrder] = useState<Order | null>(first);
  const [busy, setBusy] = useState(false);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const home = orderChannel(order?.salesModule);
  // Inside the admin, back is where the person came from; reached by address there is nowhere to go back to, so it is the screen the order belongs to.
  const previewing = asked && order !== null;
  const close = useCallback(() => {
    if (presentation === 'modal') router.back();
    else router.push(home.homeHref);
  }, [presentation, router, home.homeHref]);

  if (order === null) {
    return (
      <Modal title="Order not found" onClose={close}>
        <p className="text-sm text-fg-muted">That order could not be found. It may have been removed, or the link is not right.</p>
        <button type="button" className="mt-4 inline-flex min-h-11 cursor-pointer items-center rounded-xl border border-line px-4 text-sm font-semibold hover:bg-hover" onClick={close}>{presentation === 'modal' ? 'Close' : `Back to ${home.homeName}`}</button>
      </Modal>
    );
  }

  // The preview is part of the address, so coming back to this order from another window (the product opened from one of its lines) finds the preview open again.
  const showPreview = (open: boolean) => {
    window.history.replaceState(null, '', open ? invoiceHref(order.id) : orderHref(order.id));
  };
  const changed = (next: Order) => {
    setOrder(next);
    announceOrdersChanged();
  };
  const invoice = async (action: 'download' | 'email', type: 'tax_invoice' | 'proforma' | 'delivery_invoice') => {
    setInvoiceBusy(true);
    setNotice(null);
    setError(null);
    try {
      const kind = { proforma: 'Proforma invoice', delivery_invoice: 'Delivery invoice', tax_invoice: 'Posted tax invoice' }[type];
      if (action === 'download') {
        const result = await generateInvoicePdfAction(order.id, type);
        downloadPdfBase64(result.pdfBase64, result.filename);
        setNotice(`${kind} ${result.invoiceNumber} downloaded.`);
      } else {
        const result = await emailInvoiceAction(order.id, type);
        downloadPdfBase64(result.pdfBase64, result.filename);
        const id = result.emailMessageId ?? '';
        setNotice(`${kind} ${result.invoiceNumber} emailed to customer${id === '' ? '' : ` (${id})`}.`);
      }
    } catch (err: unknown) {
      setError(messageOf(err, action === 'download' ? 'Invoice generation failed' : 'Invoice email failed'));
    } finally {
      setInvoiceBusy(false);
    }
  };
  const save = async (change: FulfilmentChange) => {
    setBusy(true);
    setError(null);
    try {
      const result = await updateOrderStatusAction(order.id, change);
      if (result.ok) changed(result.data);
      else setError(result.error);
    } catch (err: unknown) {
      setError(messageOf(err, 'The order could not be updated.'));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await cancelOrderAction(order.id, reason);
      if (result.ok) changed(result.data);
      else setError(result.error);
    } catch (err: unknown) {
      setError(messageOf(err, 'The order could not be cancelled.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <OrderDetailsModal
        key={order.id}
        order={order}
        presentation={presentation}
        canEditProducts={canEditProducts}
        busy={busy}
        invoiceBusy={invoiceBusy}
        error={error}
        notice={notice}
        onClose={close}
        onPreview={() => showPreview(true)}
        onInvoice={(action, type) => void invoice(action, type)}
        onSave={(change) => void save(change)}
        onCancel={(reason) => void cancel(reason)}
        onChanged={announceOrdersChanged}
      />
      {previewing ? (
        <OrderInvoicePreview
          order={order}
          canEditProducts={canEditProducts}
          company={company}
          busy={invoiceBusy}
          onClose={() => showPreview(false)}
          onEmail={() => void invoice('email', 'tax_invoice')}
          onDownload={(type) => void invoice('download', type)}
        />
      ) : null}
    </>
  );
}
