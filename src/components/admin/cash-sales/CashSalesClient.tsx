'use client';

import { Suspense, use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Package, Trash2 } from 'lucide-react';
import { finishReturnAction, cashSaleReceiptAction, cashSalesMoreAction, cashSalePackageBuilderAction, cashSalesScreenAction, completeCashSaleAction, priceCashSaleAction, type CashSalesScreen, type SaleRow } from '@/server/domains/selling/cash-sales/cash-sale-actions';
import type { SaleSummary } from '@/server/domains/selling/cash-sales/cash-sale-service';
import { planTenders, type TenderKind } from '@/server/domains/selling/cash-sales/tender-rules';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { ReturnPanel } from './ReturnPanel';
import { Chip, Field, LoadFailed, PageHeader, PageSkeleton, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { QuotePackageDialog, type ChosenPackage, type PackageDialogSource } from '@/components/admin/quotes/QuotePackageDialog';
import type { Choice } from '@/lib/payment-options';
import { orElse } from '@/lib/values';

type First = Awaited<ReturnType<typeof cashSalesScreenAction>>;

const money = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let counter = 0;
const nextKey = (): string => `row-${String((counter += 1))}`;
const PACKAGES = { source: 'cash-sale-packages', load: cashSalePackageBuilderAction, addLabel: 'Add to the sale' } satisfies PackageDialogSource;

interface Line {
  key: string;
  productId: string;
  name: string;
  quantity: string;
  package?: { picks: ChosenPackage['picks']; note: string };
}
interface TenderRow {
  key: string;
  method: Choice | null;
  amount: string;
  reference: string;
}

export function CashSalesClient({ firstPromise }: { firstPromise: Promise<First> }) {
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Suspense fallback={<PageSkeleton label="Loading the counter" />}>
        <Loaded firstPromise={firstPromise} />
      </Suspense>
    </div>
  );
}

function Loaded({ firstPromise }: { firstPromise: Promise<First> }) {
  const first = use(firstPromise);
  if (!first.ok) return <LoadFailed error={first.error} />;
  return <Counter initial={first.data} />;
}

const KIND_OF = (choice: Choice | null): TenderKind | null => {
  const kind = choice?.meta?.kind;
  return kind === 'cash' || kind === 'mobile_money' || kind === 'card' ? kind : null;
};

function Counter({ initial }: { initial: CashSalesScreen }) {
  const [data, setData] = useState(initial);
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Choice | null>(null);
  const [tenders, setTenders] = useState<TenderRow[]>([{ key: nextKey(), method: null, amount: '', reference: '' }]);
  const [pickerKey, setPickerKey] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [saleKey, setSaleKey] = useState(() => crypto.randomUUID());
  const [answer, setAnswer] = useState<{ for: string; total: number; tax: number; problem: string | null } | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [unfinished, setUnfinished] = useState(false);
  const [receipt, setReceipt] = useState<SaleSummary | null>(null);
  const [returning, setReturning] = useState<string | null>(null);
  const [finishNotice, setFinishNotice] = useState<string | null>(null);

  const payload = { customerId: customer?.id ?? '', lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), ...(l.package === undefined ? {} : { package: { picks: l.package.picks, note: l.package.note } }) })) };
  const ready = lines.length > 0 && lines.every((l) => Number(l.quantity) > 0);
  const wanted = useDebouncedValue(ready ? JSON.stringify(payload) : '', 400);
  useEffect(() => {
    if (wanted === '') return;
    let live = true;
    void priceCashSaleAction(JSON.parse(wanted) as unknown).then((r) => {
      if (live) setAnswer(r.ok ? { for: wanted, total: r.data.total, tax: r.data.tax, problem: null } : { for: wanted, total: 0, tax: 0, problem: r.error });
    });
    return () => {
      live = false;
    };
  }, [wanted]);
  // An answer counts only for the lines it was worked out for; once they change, the total waits for the next answer.
  const current = answer !== null && answer.for === wanted && wanted !== '' ? answer : null;
  const priced = current?.problem === null ? { total: current.total, tax: current.tax } : null;
  const pricing = current?.problem ?? null;

  const requests = tenders.flatMap((t) => {
    const kind = KIND_OF(t.method);
    return t.method === null || kind === null || t.amount.trim() === '' ? [] : [{ methodId: t.method.id, kind, amount: Number(t.amount), reference: t.reference.trim() === '' ? null : t.reference.trim() }];
  });
  const plan = priced === null || requests.length === 0 ? null : planTenders(priced.total, requests);
  const needsReference = tenders.some((t) => t.method?.meta?.requiresReference === 'yes' && t.reference.trim() === '');

  const reload = async () => {
    const r = await cashSalesScreenAction();
    if (r.ok) {
      setData(r.data);
      setVersion((n) => n + 1);
    }
  };
  const resetSale = () => {
    setLines([]);
    setCustomer(null);
    setTenders([{ key: nextKey(), method: null, amount: '', reference: '' }]);
    setSaleKey(crypto.randomUUID());
    setProblem(null);
    setUnfinished(false);
  };
  const complete = async () => {
    if (plan?.ok !== true) return;
    setBusy(true);
    setProblem(null);
    const r = await completeCashSaleAction({ ...payload, saleKey, tenders: tenders.flatMap((t) => (t.method === null ? [] : [{ methodId: t.method.id, amount: Number(t.amount), reference: t.reference }])) });
    setBusy(false);
    if (r.ok) {
      setReceipt(r.data);
      resetSale();
      await reload();
    } else {
      setProblem(r.error);
      setUnfinished(r.unfinished !== undefined);
    }
  };
  const finishReturn = async (returnId: string) => {
    const r = await finishReturnAction(returnId);
    setFinishNotice(r.ok ? (r.data.next ?? `Return ${r.data.creditNoteNo} is finished.`) : r.error);
    await reload();
  };
  const showReceipt = async (orderId: string) => {
    const r = await cashSaleReceiptAction(orderId);
    if (r.ok && r.data !== null) setReceipt(r.data);
    else setProblem(r.ok ? 'That receipt could not be found.' : r.error);
  };

  let buttonWords = 'Complete sale';
  if (unfinished) buttonWords = 'Finish payment';
  if (busy) buttonWords = 'Working…';
  const shift = data.shift;
  const canSell = data.can.create && shift !== null && shift.status === 'open';
  return (
    <>
      <PageHeader title="Cash Sales" intro="Ring up a sale at the counter in your open shift: add what is bought, take the payment (cash with change, M-Pesa or card, or a mix) and give the receipt." />
      <ShiftBar shift={shift} />
      {receipt === null ? null : <Receipt sale={receipt} onClose={() => setReceipt(null)} />}
      {canSell ? (
        <section className="grid gap-4 lg:grid-cols-[1fr_20rem] print:hidden" aria-label="New sale">
          <div className="space-y-4">
            <div className={`${cardClass} space-y-3`}>
              <h2 className="text-base font-bold text-fg-strong">What is being bought</h2>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <ChoicePicker key={pickerKey} label="Add a product" source="cash-sale-products" choice={null} onChoice={(c) => { if (c === null) return; setLines((current) => [...current, { key: nextKey(), productId: c.id, name: c.label, quantity: '1' }]); setPickerKey((n) => n + 1); }} placeholder="Search a product or scan its code…" />
                </div>
                <button type="button" className={buttonClass} onClick={() => setChoosing(true)}><Package className="mr-1 inline size-4" aria-hidden />Add a package</button>
              </div>
              {lines.length === 0 ? <p className="text-sm text-fg-muted" data-testid="sale-empty">Nothing added yet.</p> : (
                <ul className="space-y-2" data-testid="sale-lines">
                  {lines.map((l) => (
                    <li key={l.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-2" data-testid="sale-line">
                      <span className="min-w-0 flex-1 font-medium break-words text-fg-strong">{l.name}</span>
                      <input aria-label={`Quantity of ${l.name}`} type="number" inputMode="decimal" min={0} step="any" className={`${fieldClass} w-24`} value={l.quantity} onChange={(e) => setLines((current) => current.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)))} />
                      <button type="button" className={buttonClass} aria-label={`Remove ${l.name}`} onClick={() => setLines((current) => current.filter((x) => x.key !== l.key))}><Trash2 className="size-4" aria-hidden /></button>
                    </li>
                  ))}
                </ul>
              )}
              <ChoicePicker label="Customer (leave empty for a walk-in)" source="cash-sale-customers" choice={customer} onChoice={setCustomer} placeholder="Search a customer…" />
            </div>
            <div className={`${cardClass} space-y-3`}>
              <h2 className="text-base font-bold text-fg-strong">Payment</h2>
              <ul className="space-y-3" data-testid="tenders">
                {tenders.map((t, n) => (
                  <li key={t.key} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]" data-testid="tender">
                    <ChoicePicker label={n === 0 ? 'Paid with' : `And with (${String(n + 1)})`} source="counter-methods" choice={t.method} onChoice={(m) => setTenders((current) => current.map((x) => (x.key === t.key ? { ...x, method: m } : x)))} placeholder="Cash, M-Pesa or card…" />
                    <Field id={`amount-${t.key}`} label={KIND_OF(t.method) === 'cash' ? 'Handed over (KES)' : 'Amount (KES)'}><input id={`amount-${t.key}`} type="number" inputMode="decimal" min={0} step="0.01" className={fieldClass} value={t.amount} onChange={(e) => setTenders((current) => current.map((x) => (x.key === t.key ? { ...x, amount: e.target.value } : x)))} /></Field>
                    <div className="flex items-end gap-2">
                      {priced !== null ? <button type="button" className={buttonClass} onClick={() => setTenders((current) => current.map((x) => (x.key === t.key ? { ...x, amount: String(priced.total - requests.filter((r) => r.methodId !== t.method?.id).reduce((s, r) => s + r.amount, 0)) } : x)))}>Exact</button> : null}
                      {tenders.length > 1 ? <button type="button" className={buttonClass} aria-label="Remove this way of paying" onClick={() => setTenders((current) => current.filter((x) => x.key !== t.key))}><Trash2 className="size-4" aria-hidden /></button> : null}
                    </div>
                    {t.method?.meta?.requiresReference === 'yes' ? <div className="sm:col-span-3"><Field id={`ref-${t.key}`} label={KIND_OF(t.method) === 'card' ? 'Card slip number' : 'M-Pesa code'}><input id={`ref-${t.key}`} className={fieldClass} value={t.reference} maxLength={60} onChange={(e) => setTenders((current) => current.map((x) => (x.key === t.key ? { ...x, reference: e.target.value } : x)))} /></Field></div> : null}
                  </li>
                ))}
              </ul>
              {tenders.length < 4 ? <button type="button" className={buttonClass} onClick={() => setTenders((current) => [...current, { key: nextKey(), method: null, amount: '', reference: '' }])}>Add another way of paying</button> : null}
            </div>
          </div>
          <aside className={`${cardClass} h-fit space-y-3 lg:sticky lg:top-4`} aria-label="Sale total" aria-live="polite">
            <h2 className="text-base font-bold text-fg-strong">Total</h2>
            <p className="text-3xl font-bold text-fg-strong" data-testid="sale-total">{priced === null ? '—' : money(priced.total)}</p>
            {priced === null ? null : <p className="text-sm text-fg-muted">of which tax {money(priced.tax)}</p>}
            {pricing === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="sale-pricing-problem">{pricing}</p>}
            <PlanLine plan={plan} />
            {problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="sale-problem">{problem}</p>}
            <button type="button" className={`${primaryClass} w-full`} disabled={busy || plan?.ok !== true || needsReference} onClick={() => void complete()}>{buttonWords}</button>
            {lines.length === 0 ? null : <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={resetSale}>Clear the sale</button>}
          </aside>
        </section>
      ) : null}
      {canSell && choosing ? <QuotePackageDialog money={money} from={PACKAGES} onClose={() => setChoosing(false)} onChosen={(chosen) => { setLines((current) => [...current, { key: nextKey(), productId: chosen.productId, name: chosen.summary, quantity: String(chosen.servings), package: { picks: chosen.picks, note: chosen.note } }]); setChoosing(false); }} /> : null}
      {returning === null ? null : <ReturnPanel key={returning} orderId={returning} onClose={() => setReturning(null)} onChanged={reload} />}
      {finishNotice === null ? null : <p role="status" className="rounded-lg border border-line p-3 text-sm" data-testid="finish-notice">{finishNotice}</p>}
      <ToFinish data={data} onFinish={(id) => void finishReturn(id)} />
      <Sales key={version} data={data} onReceipt={(id) => void showReceipt(id)} onReturn={data.can.return ? setReturning : undefined} />
    </>
  );
}

function PlanLine({ plan }: { plan: ReturnType<typeof planTenders> | null }) {
  if (plan === null) return null;
  if (!plan.ok) return <p role="alert" className="text-sm text-amber-700" data-testid="sale-plan-problem">{plan.error}</p>;
  return <p className="text-lg font-semibold text-emerald-700" data-testid="sale-change">Change to give: {money(plan.changeDue)}</p>;
}

function ShiftBar({ shift }: { shift: CashSalesScreen['shift'] }) {
  if (shift === null) {
    return (
      <div className={`${cardClass} space-y-2`} data-testid="no-shift">
        <p className="font-semibold text-fg-strong">You have no shift open.</p>
        <p className="text-sm text-fg-muted">A sale is rung up in your own open shift on a till. Open one first.</p>
        <Link href="/admin/shifts" className={buttonClass}>Open a shift</Link>
      </div>
    );
  }
  return (
    <div className={`${cardClass} flex flex-wrap items-center justify-between gap-3 print:hidden`} data-testid="shift-bar">
      <div className="min-w-0">
        <p className="font-semibold break-words text-fg-strong">{shift.registerName}, {shift.branchName}</p>
        <p className="text-sm text-fg-muted">{shift.takings.count} sale(s) so far · the till should hold {money(shift.expectedCash)}</p>
      </div>
      <div className="flex items-center gap-2">
        {shift.status === 'closing' ? <Chip tone="amber">Close waiting for approval</Chip> : <Chip tone="green">Shift open</Chip>}
        <Link href="/admin/shifts" className={buttonClass}>Shift and reports</Link>
      </div>
    </div>
  );
}

function Receipt({ sale, onClose }: { sale: SaleSummary; onClose: () => void }) {
  return (
    <section className={`${cardClass} space-y-2 text-sm`} aria-label="Receipt" data-testid="receipt">
      <h2 className="text-base font-bold text-fg-strong">Receipt {orElse(sale.receiptNumber, '(being made)')}</h2>
      <p className="text-fg-muted">Sale {sale.orderNumber} · {sale.customerName}</p>
      <dl className="space-y-1">
        <div className="flex justify-between gap-3 font-semibold text-fg-strong"><dt>Total</dt><dd className="font-mono">{money(sale.total)}</dd></div>
        {sale.tenders.map((t) => (
          <div key={t.label + t.kind} className="flex justify-between gap-3"><dt>{t.label}{t.reference === null ? '' : ` (${t.reference})`}</dt><dd className="font-mono">{money(t.applied)}</dd></div>
        ))}
        <div className="flex justify-between gap-3 text-lg font-bold text-fg-strong"><dt>Change given</dt><dd className="font-mono" data-testid="receipt-change">{money(sale.changeDue)}</dd></div>
      </dl>
      {sale.warning === undefined ? null : <p role="alert" className="text-amber-700">{sale.warning}</p>}
      <div className="flex gap-2 print:hidden">
        <button type="button" className={buttonClass} onClick={() => window.print()}>Print receipt</button>
        <button type="button" className={primaryClass} onClick={onClose}>New sale</button>
      </div>
    </section>
  );
}

function ToFinish({ data, onFinish }: { data: CashSalesScreen; onFinish: (returnId: string) => void }) {
  if (data.returns.length === 0) return null;
  return (
    <section className="space-y-2 print:hidden" aria-label="Returns to finish" data-testid="returns-to-finish">
      <h2 className="text-sm font-bold tracking-wider text-fg-subtle uppercase">Returns to finish</h2>
      <ul className="space-y-1 text-sm">{data.returns.map((r) => <li key={r.returnId}>{r.orderNumber} · {money(r.amount)} · {r.status === 'refund_pending' ? 'refund waiting for approval' : 'refund to be paid'} <button type="button" className={buttonClass} aria-label={`Finish the return of ${r.orderNumber}`} onClick={() => onFinish(r.returnId)}>Finish</button></li>)}</ul>
    </section>
  );
}

function Sales({ data, onReceipt, onReturn }: { data: CashSalesScreen; onReceipt: (orderId: string) => void; onReturn?: (orderId: string) => void }) {
  const [rows, setRows] = useState<SaleRow[]>(data.sales.rows);
  const [next, setNext] = useState(data.sales.next);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showMore = async () => {
    if (next === null) return;
    setMore(true);
    const r = await cashSalesMoreAction({ cursor: next });
    setMore(false);
    if (r.ok) {
      setRows((current) => [...current, ...r.data.rows]);
      setNext(r.data.next);
    } else setError(r.error);
  };
  return (
    <section className="space-y-2 print:hidden" aria-label="Sales so far">
      <h2 className="text-sm font-bold tracking-wider text-fg-subtle uppercase">Sales so far</h2>
      {rows.length === 0 ? <p className="text-sm text-fg-muted" data-testid="sales-empty">No counter sales yet.</p> : (
        <ul className="space-y-2" data-testid="sales-list">
          {rows.map((r) => (
            <li key={r.orderId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-3" data-testid="sale-row">
              <div className="min-w-0">
                <p className="font-semibold break-words text-fg-strong">{r.receiptNumber ?? r.orderNumber} · {money(r.total)}</p>
                <p className="text-sm break-words text-fg-muted">{r.customerName} · {new Date(r.at).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-2">
                {r.paid ? null : <Chip tone="red">Payment not recorded</Chip>}
                <button type="button" className={buttonClass} aria-label={`Receipt for ${r.receiptNumber ?? r.orderNumber}`} onClick={() => onReceipt(r.orderId)}>Receipt</button>
                {onReturn === undefined || !r.paid ? null : <button type="button" className={buttonClass} aria-label={`Return goods from ${r.receiptNumber ?? r.orderNumber}`} onClick={() => onReturn(r.orderId)}>Return</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : <p role="alert" className="text-sm text-red-700">{error}</p>}
      {next === null ? null : <button type="button" className={buttonClass} disabled={more} onClick={() => void showMore()}>{more ? 'Loading…' : 'Show more'}</button>}
    </section>
  );
}
