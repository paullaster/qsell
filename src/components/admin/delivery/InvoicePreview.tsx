import { planInvoices, type DeliveryBillingMode, type InvoiceFigures } from '@/lib/delivery-invoicing';

const SAMPLE_ORDER = { subtotal: 1000, tax: 208, shippingFee: 300, totalAmount: 1508 };
const SAMPLE_DELIVERY = { net: 300, tax: 48, gross: 348, taxRate: 16 };

const money = (n: number): string => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Sheet({ title, figures, products }: { title: string; figures: InvoiceFigures; products: boolean }) {
  return (
    <figure className="min-w-0 rounded-lg border border-line bg-surface p-3 text-xs" aria-label={title}>
      <figcaption className="mb-2 text-sm font-semibold text-fg-strong">{title}</figcaption>
      <table className="w-full">
        <tbody>
          {products ? (
            <tr>
              <td className="py-0.5 text-fg">Rice 5kg, 1 × 1,000.00</td>
              <td className="py-0.5 text-right font-mono text-fg">1,000.00</td>
            </tr>
          ) : null}
          {figures.deliveryLine === null ? null : (
            <tr>
              <td className="py-0.5 text-fg">{figures.deliveryLine.name}</td>
              <td className="py-0.5 text-right font-mono text-fg">{money(figures.deliveryLine.net)}</td>
            </tr>
          )}
          <tr className="border-t border-line">
            <td className="pt-1 text-fg-muted">Subtotal</td>
            <td className="pt-1 text-right font-mono text-fg">{money(figures.subtotal)}</td>
          </tr>
          {figures.taxRows.map((r) => (
            <tr key={r.label}>
              <td className="py-0.5 text-fg-muted">{r.label}</td>
              <td className="py-0.5 text-right font-mono text-fg">{money(r.amount)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-semibold">
            <td className="pt-1 text-fg-strong">Total</td>
            <td className="pt-1 text-right font-mono text-fg-strong">{money(figures.totalAmount)}</td>
          </tr>
        </tbody>
      </table>
    </figure>
  );
}

/** What one delivered order looks like on paper (and to KRA) under a choice, with an example: products of 1,000 and delivery of 300, both with 16% tax. */
export function InvoicePreview({ mode }: { mode: DeliveryBillingMode }) {
  const plan = planInvoices(SAMPLE_ORDER, SAMPLE_DELIVERY, mode);
  return (
    <div className="space-y-2" role="group" aria-label="How it looks">
      <p className="text-xs text-fg-muted">An example: products of 1,000 and delivery of 300 before tax, both with 16% tax.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Sheet title={mode === 'with_goods' ? 'The invoice' : 'Invoice for the products'} figures={plan.main} products />
        {plan.deliveryInvoice === null ? null : <Sheet title="Invoice for the delivery service" figures={plan.deliveryInvoice} products={false} />}
      </div>
    </div>
  );
}
