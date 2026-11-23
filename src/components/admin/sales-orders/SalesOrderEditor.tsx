'use client';

import { useEffect, useId, useState } from 'react';
import { Package } from 'lucide-react';
import { placeSalesOrderAction, priceSalesOrderAction, salesOrderBehaviourAction, salesOrderCreditAction, salesOrderPackageBuilderAction } from '@/server/domains/selling/sales-order-actions';
import { creditSaleBehaviourAction, creditSaleCreditAction, creditSalePackageBuilderAction, placeCreditSaleAction, priceCreditSaleAction } from '@/server/domains/selling/credit-sale-actions';
import { issueSalesInvoiceAction, priceSalesInvoiceAction, salesInvoiceBehaviourAction, salesInvoiceCreditAction, salesInvoicePackageBuilderAction } from '@/server/domains/selling/direct-invoice-actions';
import type { CreditPosition } from '@/server/domains/selling/sales-order-service';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { QuotePackageDialog, type ChosenPackage, type PackageDialogSource } from '@/components/admin/quotes/QuotePackageDialog';
import type { Choice } from '@/lib/payment-options';
import { SellingLines } from '@/components/admin/selling/SellingLines';
import { listEstimate, payloadLine, quantityOf, readyToPlace, type DocLine, type Priced } from '@/lib/selling/lines';
import type { LineDiscount } from '@/lib/till/cart';

/** The two documents this editor takes: an order for later, or a sale invoiced directly. Each has its own pickers and builder (behind the permission of taking it). */
const VARIANTS = {
  sales_order: {
    title: 'New sales order',
    submit: 'Place order',
    working: 'Placing…',
    prefix: 'sales-order',
    packages: { source: 'sales-order-packages', load: salesOrderPackageBuilderAction, addLabel: 'Add to the order' } satisfies PackageDialogSource,
    behaviour: salesOrderBehaviourAction,
    price: priceSalesOrderAction,
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
    price: priceSalesInvoiceAction,
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
    price: priceCreditSaleAction,
    credit: creditSaleCreditAction,
    showPayment: false,
  },
} as const;
export type EditorVariant = keyof typeof VARIANTS;

/** Why no price is shown yet, in words. */
function whyNoPrice(hasCustomer: boolean, busy: boolean): string {
  if (!hasCustomer) return 'Choose the customer to see the price they will pay.';
  return busy ? 'Working out the price for this customer…' : 'The price for this customer is worked out as you go.';
}

/** The figures at the foot of the document: the server's price for this customer when it has one, else the list-price guide and why. */
function OrderTotals({ empty, priced, guide, reason }: { empty: boolean; priced: Priced | null; guide: number | null; reason: string }) {
  const row = 'flex items-baseline gap-2';
  let figures: React.ReactNode;
  if (empty) {
    figures = <div><dt className="sr-only">Total</dt><dd className="text-fg-muted">No lines yet</dd></div>;
  } else if (priced === null) {
    figures = <div className={row}><dt className="text-fg-muted">At list prices</dt><dd className="font-mono text-lg font-bold tabular-nums text-fg-strong">{guide === null ? '—' : money(guide)}</dd><dd className="text-xs text-fg-muted">{reason}</dd></div>;
  } else {
    figures = (
      <>
        <div className={row}><dt className="text-fg-muted">Before tax</dt><dd className="font-mono tabular-nums">{money(priced.subtotal)}</dd></div>
        <div className={row}><dt className="text-fg-muted">Tax</dt><dd className="font-mono tabular-nums">{money(priced.tax)}</dd></div>
        <div className={row}><dt className="font-bold text-fg-strong">Total</dt><dd className="font-mono text-xl font-bold tabular-nums text-fg-strong" data-testid="order-total">{money(priced.total)}</dd></div>
      </>
    );
  }
  return <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm" data-testid="order-totals" aria-live="polite">{figures}</dl>;
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
      <p className="text-fg-muted">{credit.creditLimitDisplay === 'static' ? `Set credit limit ${money(credit.creditLimit)} · owed ${money(credit.balance)}` : `Limit ${money(credit.creditLimit)} · owed ${money(credit.balance)} · available ${money(credit.available)}`}</p>
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
  const [lines, setLines] = useState<DocLine[]>([]);
  const [pickerKey, setPickerKey] = useState(0);
  const [payment, setPayment] = useState<Choice>({ id: 'mpesa_daraja', label: 'M-Pesa' });
  const [neededOn, setNeededOn] = useState('');
  const [hold, setHold] = useState(false);
  const [canHold, setCanHold] = useState(false);
  const [rights, setRights] = useState({ canPrice: false, canDiscount: false, discountSwitchedOff: false });
  const [priced, setPriced] = useState<Priced | null>(null);
  const [pricing, setPricing] = useState<{ busy: boolean; problem: string | null }>({ busy: false, problem: null });
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void v.behaviour().then((r) => {
      if (live && r.ok) {
        setCanHold(r.data.allowHoldUntilPaid);
        setRights({ canPrice: r.data.canPrice, canDiscount: r.data.canDiscount, discountSwitchedOff: r.data.discountSwitchedOff });
      }
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
    const list = Number(c.meta?.price);
    setLines((current) => [...current, { key: nextKey(), productId: c.id, name: c.label, quantity: '1', listPrice: Number.isFinite(list) ? list : null }]);
    setPickerKey((n) => n + 1);
  };
  const addPackage = (chosen: ChosenPackage) => {
    setLines((current) => [...current, { key: nextKey(), productId: chosen.productId, name: chosen.summary, quantity: String(chosen.servings), listPrice: null, package: { picks: chosen.picks, note: chosen.note, summary: chosen.summary } }]);
    setChoosing(false);
  };
  const setQuantity = (key: string, quantity: string) => setLines((current) => current.map((l) => (l.key === key ? { ...l, quantity } : l)));
  const setPrice = (key: string, price: number | null) => setLines((current) => current.map((l) => {
    if (l.key !== key) return l;
    const { price: _was, ...rest } = l;
    return price === null ? rest : { ...rest, price };
  }));
  const giveDiscount = (key: string, discount: LineDiscount | null) => setLines((current) => current.map((l) => {
    if (l.key !== key) return l;
    const { discount: _was, ...rest } = l;
    return discount === null ? rest : { ...rest, discount };
  }));
  const documentFor = (forCustomer: Choice): Record<string, unknown> => ({ customerId: forCustomer.id, lines: lines.map(payloadLine), paymentMethod: payment.id, neededOn, holdUntilPaid: hold });

  // The server prices the lines for this customer as they are typed: the unit price, the line total and the tax shown are the ones that will be charged.
  const priceKey = customer === null ? '' : JSON.stringify(documentFor(customer));
  const askable = customer !== null && lines.length > 0 && lines.every((l) => quantityOf(l) > 0);
  useEffect(() => {
    if (!askable) return undefined;
    let live = true;
    const wait = setTimeout(() => {
      setPricing({ busy: true, problem: null });
      void v.price(JSON.parse(priceKey) as unknown).then((r) => {
        if (!live) return;
        if (r.ok) { setPriced(r.data); setPricing({ busy: false, problem: null }); } else { setPriced(null); setPricing({ busy: false, problem: r.error }); }
      });
    }, 350);
    return () => { live = false; clearTimeout(wait); };
  }, [askable, priceKey, v]);
  const shownPrices = askable ? priced : null;

  const place = async () => {
    if (customer === null) return;
    setBusy(true);
    setProblem(null);
    const payload = {
      customerId: customer.id,
      lines: lines.map(payloadLine),
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
  const ready = readyToPlace(customer !== null, lines);
  const guide = listEstimate(lines);

  return (
    <form aria-label={v.title} className={`${cardClass} space-y-4`} onSubmit={(e) => { e.preventDefault(); if (ready) void place(); }}>
      <h2 className="text-base font-bold text-fg-strong">{v.title}</h2>

      <div className="grid gap-3 md:grid-cols-3">
        <ChoicePicker label="Customer" source={`${v.prefix}-customers`} choice={customer} onChoice={chooseCustomer} placeholder="Search customers…" required />
        {v.showPayment ? <ChoicePicker label="Expected payment" source={`${v.prefix}-payment-methods`} clearable={false} choice={payment} onChoice={(c) => c !== null && setPayment(c)} /> : <p className="self-end pb-2 text-sm text-fg-muted">Paid by the customer on their account terms.</p>}
        <Field id={`${id}-needed`} label="Needed on (optional)">
          <input id={`${id}-needed`} type="date" className={fieldClass} value={neededOn} onChange={(e) => setNeededOn(e.target.value)} />
        </Field>
      </div>
      {credit === null ? null : <div className="rounded-lg border border-line bg-surface p-3"><CreditCard credit={credit} /></div>}
      {canHold ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={hold} onChange={(e) => setHold(e.target.checked)} />
          Hold the stock until this order is paid
        </label>
      ) : null}

      <section className="space-y-2" aria-label="What they buy">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 className="text-sm font-bold tracking-wider text-fg-subtle uppercase">What they buy{lines.length === 0 ? '' : ` · ${String(lines.length)} ${lines.length === 1 ? 'line' : 'lines'}`}</h3>
          {rights.discountSwitchedOff ? <p className="text-xs text-fg-muted" data-testid="discount-off-note">Discounts are switched off for your branch. They are turned on in Settings, Sales, Selling documents.</p> : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <ChoicePicker key={pickerKey} label="Add a product" source={`${v.prefix}-products`} choice={null} onChoice={addProduct} placeholder="Search by name or code…" />
          <button type="button" className={`${buttonClass} self-end`} onClick={() => setChoosing(true)}><Package className="mr-1 h-4 w-4" aria-hidden="true" />Add a package</button>
        </div>
        {lines.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-sm text-fg-muted">Nothing here yet. Search for a product above to add the first line.</p> : (
          <SellingLines lines={lines} priced={shownPrices} canPrice={rights.canPrice} canDiscount={rights.canDiscount} onQuantity={setQuantity} onPrice={setPrice} onDiscount={giveDiscount} onRemove={(key) => setLines((current) => current.filter((x) => x.key !== key))} />
        )}
        {pricing.problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="pricing-problem">{pricing.problem}</p>}
      </section>

      {/* The totals and the buttons stay at the foot of the screen however long the lines are. */}
      <div className="sticky bottom-0 z-20 -mx-4 -mb-4 space-y-2 rounded-b-xl border-t border-line bg-surface-raised/95 px-4 py-3 backdrop-blur sm:-mx-5 sm:-mb-5 sm:px-5" data-testid="order-footer">
        <div aria-live="polite">{problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="order-problem">{problem}</p>}</div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <OrderTotals empty={lines.length === 0} priced={shownPrices} guide={guide} reason={whyNoPrice(customer !== null, pricing.busy)} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className={`${primaryClass} min-h-11 px-6`} disabled={!ready || busy}>{busy ? v.working : v.submit}</button>
          </div>
        </div>
      </div>
      {choosing ? <QuotePackageDialog money={money} from={v.packages} onClose={() => setChoosing(false)} onChosen={addPackage} /> : null}
    </form>
  );
}
