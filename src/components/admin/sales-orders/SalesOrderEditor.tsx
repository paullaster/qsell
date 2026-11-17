'use client';

import { useEffect, useId, useState } from 'react';
import { Package, Trash2 } from 'lucide-react';
import { placeSalesOrderAction, salesOrderBehaviourAction, salesOrderCreditAction, salesOrderPackageBuilderAction } from '@/server/domains/selling/sales-order-actions';
import { creditSaleBehaviourAction, creditSaleCreditAction, creditSalePackageBuilderAction, placeCreditSaleAction } from '@/server/domains/selling/credit-sale-actions';
import { issueSalesInvoiceAction, salesInvoiceBehaviourAction, salesInvoiceCreditAction, salesInvoicePackageBuilderAction } from '@/server/domains/selling/direct-invoice-actions';
import type { CreditPosition } from '@/server/domains/selling/sales-order-service';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { QuotePackageDialog, type ChosenPackage, type PackageDialogSource } from '@/components/admin/quotes/QuotePackageDialog';
import type { Choice } from '@/lib/payment-options';

/** The two documents this editor takes: an order for later, or a sale invoiced directly. Each has its own pickers and builder (behind the permission of taking it). */
const VARIANTS = {
  sales_order: {
    title: 'New sales order',
    submit: 'Place order',
    working: 'Placing…',
    prefix: 'sales-order',
    packages: { source: 'sales-order-packages', load: salesOrderPackageBuilderAction, addLabel: 'Add to the order' } satisfies PackageDialogSource,
    behaviour: salesOrderBehaviourAction,
    credit: salesOrderCreditAction,
    showPayment: true,
  },
  sales_invoice: {
    title: 'New sales invoice',
    submit: 'Issue invoice',
    working: 'Issuing…',
    prefix: 'sales-invoice',
    packages: { source: 'sales-invoice-packages', load: salesInvoicePackageBuilderAction, addLabel: 'Add to the invoice' } satisfies PackageDialogSource,
    behaviour: salesInvoiceBehaviourAction,
    credit: salesInvoiceCreditAction,
    showPayment: true,
  },
  credit_sale: {
    title: 'New credit sale',
    submit: 'Place credit sale',
    working: 'Placing…',
    prefix: 'credit-sale',
    packages: { source: 'credit-sale-packages', load: creditSalePackageBuilderAction, addLabel: 'Add to the sale' } satisfies PackageDialogSource,
    behaviour: creditSaleBehaviourAction,
    credit: creditSaleCreditAction,
    showPayment: false,
  },
} as const;
export type EditorVariant = keyof typeof VARIANTS;

interface Line {
  key: string;
  productId: string;
  name: string;
  quantity: string;
  /** The list price now, for an estimate only; the server prices the order. */
  price: number | null;
  package?: { picks: ChosenPackage['picks']; note: string; summary: string };
}

const money = (amount: number): string => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' }).format(amount);
let counter = 0;
const nextKey = (): string => `line-${String((counter += 1))}`;

function CreditCard({ credit }: { credit: CreditPosition }) {
  if (!credit.hasCreditAccount) {
    return <p className="text-sm text-fg-muted" data-testid="credit-position">{credit.name} is a cash customer: no credit account.</p>;
  }
  return (
    <div className="space-y-1 text-sm" data-testid="credit-position">
      <p className="font-medium text-fg-strong">{credit.name}: credit account on {credit.termDays} days</p>
      <p className="text-fg-muted">Limit {money(credit.creditLimit)} · owed {money(credit.balance)} · available {money(credit.available)}</p>
      {credit.blocked ? <p role="alert" className="text-red-700">This customer is blocked from buying.</p> : null}
      {credit.overdue ? <p role="alert" className="text-amber-700">This customer has an invoice that is overdue.</p> : null}
    </div>
  );
}

/** Taking a sales order for a customer: who it is for, what they buy (products and packages), when they need it, and how they will pay. The server prices it and applies the company's settings. */
export function SalesOrderEditor({ onCancel, onPlaced, variant = 'sales_order' }: { onCancel: () => void; onPlaced: (text: string) => void; variant?: EditorVariant }) {
  const id = useId();
  const v = VARIANTS[variant];
  const [customer, setCustomer] = useState<Choice | null>(null);
  const [credit, setCredit] = useState<CreditPosition | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [pickerKey, setPickerKey] = useState(0);
  const [payment, setPayment] = useState<Choice>({ id: 'mpesa_daraja', label: 'M-Pesa' });
  const [neededOn, setNeededOn] = useState('');
  const [hold, setHold] = useState(false);
  const [canHold, setCanHold] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void v.behaviour().then((r) => {
      if (live && r.ok) setCanHold(r.data.allowHoldUntilPaid);
    });
    return () => {
      live = false;
    };
  }, [v]);

  const chooseCustomer = (c: Choice | null) => {
    setCustomer(c);
    setCredit(null);
    if (c === null) return;
    void v.credit(c.id).then((r) => {
      if (r.ok) setCredit((current) => (current === null || current.customerId === c.id ? r.data : current));
    });
  };
  const addProduct = (c: Choice | null) => {
    if (c === null) return;
    const price = Number(c.meta?.price);
    setLines((current) => [...current, { key: nextKey(), productId: c.id, name: c.label, quantity: '1', price: Number.isFinite(price) ? price : null }]);
    setPickerKey((n) => n + 1);
  };
  const addPackage = (chosen: ChosenPackage) => {
    setLines((current) => [...current, { key: nextKey(), productId: chosen.productId, name: chosen.summary, quantity: String(chosen.servings), price: null, package: { picks: chosen.picks, note: chosen.note, summary: chosen.summary } }]);
    setChoosing(false);
  };
  const setQuantity = (key: string, quantity: string) => setLines((current) => current.map((l) => (l.key === key ? { ...l, quantity } : l)));
  const estimate = lines.reduce((sum, l) => sum + (l.package === undefined && l.price !== null ? l.price * (Number.isFinite(Number(l.quantity)) ? Number(l.quantity) : 0) : 0), 0);
  const unpriced = lines.some((l) => l.package !== undefined || l.price === null);

  const place = async () => {
    if (customer === null) return;
    setBusy(true);
    setProblem(null);
    const payload = {
      customerId: customer.id,
      lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), ...(l.package === undefined ? {} : { package: { picks: l.package.picks, note: l.package.note } }) })),
      paymentMethod: payment.id,
      neededOn,
      holdUntilPaid: hold,
    };
    if (variant === 'credit_sale') {
      const r = await placeCreditSaleAction(payload);
      setBusy(false);
      if (r.ok) onPlaced(`Credit sale ${r.data.orderNumber} placed${r.data.invoiceNumber === null ? '' : ` with invoice ${r.data.invoiceNumber}`}${r.data.waitingForApproval ? ' and waiting for approval' : ''}.`);
      else setProblem(r.error);
      return;
    }
    if (variant === 'sales_invoice') {
      const r = await issueSalesInvoiceAction(payload);
      setBusy(false);
      if (r.ok) onPlaced(`${r.data.invoiceNumber === null ? `Sales invoice for order ${r.data.orderNumber} issued without an invoice number yet` : `Invoice ${r.data.invoiceNumber} issued for order ${r.data.orderNumber}`}${r.data.waitingForApproval ? ' and waiting for approval' : ''}.`);
      else setProblem(r.error);
      return;
    }
    const r = await placeSalesOrderAction(payload);
    setBusy(false);
    if (r.ok) onPlaced(`Sales order ${r.data.orderNumber} placed${r.data.waitingForApproval ? ' and waiting for approval' : ''}.`);
    else setProblem(r.error);
  };
  const ready = customer !== null && lines.length > 0 && lines.every((l) => Number(l.quantity) > 0);

  return (
    <form aria-label={v.title} className={`${cardClass} space-y-4`} onSubmit={(e) => { e.preventDefault(); if (ready) void place(); }}>
      <h2 className="text-base font-bold text-fg-strong">{v.title}</h2>
      <ChoicePicker label="Customer" source={`${v.prefix}-customers`} choice={customer} onChoice={chooseCustomer} placeholder="Search customers…" required />
      {credit === null ? null : <div className="rounded-lg border border-line bg-surface p-3"><CreditCard credit={credit} /></div>}

      <section className="space-y-2" aria-label="What they buy">
        <h3 className="text-sm font-bold tracking-wider text-fg-subtle uppercase">What they buy</h3>
        {lines.length === 0 ? <p className="text-sm text-fg-muted">Nothing yet. Add a product or a package.</p> : (
          <ul className="space-y-2" aria-label="Lines of the order">
            {lines.map((l) => (
              <li key={l.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3" data-testid="order-line">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="font-medium break-words text-fg-strong">{l.package === undefined ? l.name : <><Package className="mr-1 inline h-4 w-4" aria-hidden="true" />{l.name}</>}</p>
                  {l.package === undefined && l.price !== null ? <p className="text-xs text-fg-muted">List price {money(l.price)}</p> : null}
                </div>
                <label className="text-sm text-fg-muted">
                  <span className="sr-only">{l.package === undefined ? `Quantity of ${l.name}` : `Servings of ${l.name}`}</span>
                  <input type="number" min={l.package === undefined ? 0.001 : 1} step={l.package === undefined ? 'any' : 1} className={`${fieldClass} w-28`} value={l.quantity} onChange={(e) => setQuantity(l.key, e.target.value)} aria-label={l.package === undefined ? `Quantity of ${l.name}` : `Servings of ${l.name}`} />
                </label>
                <button type="button" className={buttonClass} aria-label={`Remove ${l.name}`} onClick={() => setLines((current) => current.filter((x) => x.key !== l.key))}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <ChoicePicker key={pickerKey} label="Add a product" source={`${v.prefix}-products`} choice={null} onChoice={addProduct} placeholder="Search products…" />
          <button type="button" className={`${buttonClass} self-end`} onClick={() => setChoosing(true)}><Package className="mr-1 h-4 w-4" aria-hidden="true" />Add a package</button>
        </div>
        {lines.length === 0 ? null : <p className="text-sm text-fg-muted" data-testid="order-estimate">Estimate at list prices: {money(estimate)}{unpriced ? ' plus packages and any price that has no list price' : ''}. The price is worked out for this customer when you place the order.</p>}
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        {v.showPayment ? <ChoicePicker label="Expected payment" source={`${v.prefix}-payment-methods`} clearable={false} choice={payment} onChoice={(c) => c !== null && setPayment(c)} /> : <p className="self-end text-sm text-fg-muted">Paid by the customer on their account terms.</p>}
        <Field id={`${id}-needed`} label="Needed on (optional)">
          <input id={`${id}-needed`} type="date" className={fieldClass} value={neededOn} onChange={(e) => setNeededOn(e.target.value)} />
        </Field>
      </div>
      {canHold ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={hold} onChange={(e) => setHold(e.target.checked)} />
          Hold the stock until this order is paid
        </label>
      ) : null}

      <div aria-live="polite">{problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="order-problem">{problem}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primaryClass} disabled={!ready || busy}>{busy ? v.working : v.submit}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {choosing ? <QuotePackageDialog money={money} from={v.packages} onClose={() => setChoosing(false)} onChosen={addPackage} /> : null}
    </form>
  );
}
