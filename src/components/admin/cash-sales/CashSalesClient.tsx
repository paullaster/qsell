'use client';

import { Suspense, use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { LogOut, Receipt as ReceiptIcon } from 'lucide-react';
import { finishReturnAction, cashSaleReceiptAction, cashSalesMoreAction, cashSalePackageBuilderAction, cashSalesScreenAction, completeCashSaleAction, priceCashSaleAction, type CashSalesScreen, type SaleRow } from '@/server/domains/selling/cash-sales/cash-sale-actions';
import { discardHeldSaleAction, holdSaleAction, recallHeldSaleAction, tillStartAction, type TillStart } from '@/server/domains/selling/cash-sales/till-actions';
import type { SaleSummary } from '@/server/domains/selling/cash-sales/cash-sale-service';
import type { CounterTile } from '@/server/domains/selling/cash-sales/counter-catalogue-service';
import type { HeldSaleRow } from '@/server/domains/selling/cash-sales/held-sale-service';
import { OfflineReview } from './OfflineReview';
import { OFFLINE_TILL_PATH, prepareOfflineTill } from '@/lib/offline-till/ready';
import { ReturnPanel } from './ReturnPanel';
import { CartPane, type Priced } from './till/CartPane';
import { HeldDialog } from './till/HeldDialog';
import { PayDialog } from './till/PayDialog';
import { ProductPane } from './till/ProductPane';
import { SaleDone } from './till/SaleDone';
import { Modal } from '@/components/ui/Modal';
import { Chip, LoadFailed, PageHeader, PageSkeleton, buttonClass, cardClass } from '@/components/ui/screen-kit';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { useMediaQuery } from '@/components/ui/useMediaQuery';
import { QuotePackageDialog, type PackageDialogSource } from '@/components/admin/quotes/QuotePackageDialog';
import { addToCart, removeLine, setPrice, setQuantity, stepLine, totalShown, unitCount, type Cart } from '@/lib/till/cart';
import { kes } from '@/lib/till/tile-style';
import type { Choice } from '@/lib/payment-options';

type First = Awaited<ReturnType<typeof cashSalesScreenAction>>;

const money = (amount: number): string => kes(amount);
let counter = 0;
const nextKey = (): string => `row-${String((counter += 1))}`;
const PACKAGES = { source: 'cash-sale-packages', load: cashSalePackageBuilderAction, addLabel: 'Add to the sale' } satisfies PackageDialogSource;

export function CashSalesClient({ firstPromise }: { firstPromise: Promise<First> }) {
  return (
    <div className="mx-auto max-w-[110rem] space-y-5 p-3 sm:p-5">
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

function ProductArea({ start, problem, inCart, onPick, searchRef }: { start: TillStart | null; problem: string | null; inCart: ReadonlyMap<string, number>; onPick: (tile: CounterTile) => void; searchRef: React.RefObject<HTMLInputElement | null> }) {
  if (start !== null) return <ProductPane start={start} inCart={inCart} onPick={onPick} searchRef={searchRef} />;
  if (problem !== null) return <p role="alert" className="text-sm text-red-700">{problem}</p>;
  return <p className="py-10 text-center text-sm text-fg-muted" role="status">Loading the products…</p>;
}

function Counter({ initial }: { initial: CashSalesScreen }) {
  const [data, setData] = useState(initial);
  const [start, setStart] = useState<TillStart | null>(null);
  const [startProblem, setStartProblem] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>([]);
  const [customer, setCustomer] = useState<Choice | null>(null);
  const [choosingPackage, setChoosingPackage] = useState<string | null>(null);
  const [saleKey, setSaleKey] = useState(() => crypto.randomUUID());
  const [answer, setAnswer] = useState<{ for: string; priced: Priced | null; problem: string | null } | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [unfinished, setUnfinished] = useState(false);
  const [paying, setPaying] = useState(false);
  const [holding, setHolding] = useState(false);
  const [heldProblem, setHeldProblem] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldSaleRow[]>([]);
  const [receipt, setReceipt] = useState<SaleSummary | null>(null);
  const [showSales, setShowSales] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [returning, setReturning] = useState<string | null>(null);
  const [finishNotice, setFinishNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const desktop = useMediaQuery('(min-width: 1024px)');

  const shift = data.shift;
  const canSell = data.can.create && shift !== null && shift.status === 'open';
  const fullscreen = data.tillMode === 'fullscreen' && canSell;

  useEffect(() => {
    if (!canSell) return;
    let live = true;
    void tillStartAction().then((r) => {
      if (!live) return;
      if (r.ok) {
        setStart(r.data);
        setHeld(r.data.held);
      } else setStartProblem(r.error);
    });
    return () => {
      live = false;
    };
  }, [canSell]);

  const payload = { customerId: customer?.id ?? '', lines: cart.map((l) => ({ productId: l.productId, quantity: l.quantity, ...(l.price === undefined ? {} : { unitPrice: l.price }), ...(l.package === undefined ? {} : { package: { picks: l.package.picks, note: l.package.note } }) })) };
  const asked = cart.length > 0 ? JSON.stringify(payload) : '';
  const wanted = useDebouncedValue(asked, 300);
  useEffect(() => {
    if (wanted === '') return;
    let live = true;
    void priceCashSaleAction(JSON.parse(wanted) as unknown).then((r) => {
      if (live) setAnswer(r.ok ? { for: wanted, priced: { total: r.data.total, tax: r.data.tax, lines: r.data.lines }, problem: null } : { for: wanted, priced: null, problem: r.error });
    });
    return () => {
      live = false;
    };
  }, [wanted]);
  // An answer counts only for the sale as it stands now; the moment the lines change (before the next question is even sent) the total and Pay wait for the next answer.
  const current = answer !== null && answer.for === asked && asked !== '' ? answer : null;
  const priced = current?.priced ?? null;
  const pricing = current?.problem ?? null;

  const inCart = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of cart) m.set(l.productId, (m.get(l.productId) ?? 0) + l.quantity);
    return m;
  }, [cart]);

  const reload = async () => {
    const r = await cashSalesScreenAction();
    if (r.ok) {
      setData(r.data);
      setVersion((n) => n + 1);
    }
  };
  const resetSale = () => {
    setCart([]);
    setCustomer(null);
    setSaleKey(crypto.randomUUID());
    setProblem(null);
    setUnfinished(false);
    setPaying(false);
    setCartOpen(false);
  };
  const pick = (tile: CounterTile) => {
    if (tile.isPackage) {
      setChoosingPackage(tile.id);
      return;
    }
    setCart((c) => addToCart(c, { productId: tile.id, name: tile.name, listPrice: tile.price, imageUrl: tile.imageUrl }, nextKey()));
    setProblem(null);
  };
  const complete = async (tenders: { methodId: string; amount: number; reference: string }[]) => {
    setBusy(true);
    setProblem(null);
    const r = await completeCashSaleAction({ ...payload, saleKey, tenders });
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
  const hold = async () => {
    if (cart.length === 0) return;
    setBusy(true);
    setHeldProblem(null);
    const r = await holdSaleAction({ label: '', sale: payload });
    setBusy(false);
    if (r.ok) {
      setHeld((h) => [...h, r.data]);
      resetSale();
    } else setProblem(r.error);
  };
  const recall = async (id: string) => {
    if (cart.length > 0) {
      setHeldProblem('Finish or put aside the sale in front of you first.');
      return;
    }
    setBusy(true);
    setHeldProblem(null);
    const r = await recallHeldSaleAction(id);
    setBusy(false);
    if (!r.ok) {
      setHeldProblem(r.error);
      return;
    }
    setHeld((h) => h.filter((x) => x.id !== id));
    setCart(r.data.lines.reduce<Cart>((acc, l) => addToCart(acc, { productId: l.productId, name: l.name, listPrice: null, imageUrl: '', ...(l.unitPrice === undefined ? {} : { price: l.unitPrice }), ...(l.package === undefined ? {} : { package: { picks: l.package.picks, note: l.package.note } }), quantity: l.quantity }, nextKey()), []));
    setSaleKey(crypto.randomUUID());
    setHolding(false);
  };
  const giveUp = async (id: string) => {
    setBusy(true);
    const r = await discardHeldSaleAction(id);
    setBusy(false);
    if (r.ok) setHeld((h) => h.filter((x) => x.id !== id));
    else setHeldProblem(r.error);
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

  const canPay = canSell && !busy && priced !== null && cart.length > 0;
  useEffect(() => {
    if (!canSell) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'F4' && canPay && !paying) { e.preventDefault(); setPaying(true); }
      else if (e.key === 'F6') { e.preventDefault(); setHolding(true); }
      else if (e.key === 'F8' && cart.length > 0 && !busy) { e.preventDefault(); void hold(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const cartPane = (
    <CartPane
      cart={cart}
      priced={priced}
      pricing={pricing}
      customer={customer}
      heldCount={held.length}
      busy={busy}
      onStep={(key, step) => setCart((c) => stepLine(c, key, step))}
      onQuantity={(key, q) => setCart((c) => setQuantity(c, key, q))}
      canPrice={data.canPrice}
      onPrice={(key, price) => setCart((c) => setPrice(c, key, price))}
      onRemove={(key) => setCart((c) => removeLine(c, key))}
      onCustomer={setCustomer}
      onHold={() => void hold()}
      onHeld={() => setHolding(true)}
      onClear={resetSale}
      onPay={() => setPaying(true)}
    />
  );
  const salesBlock = (
    <>
      {returning === null ? null : <ReturnPanel key={returning} orderId={returning} onClose={() => setReturning(null)} onChanged={reload} />}
      {finishNotice === null ? null : <p role="status" className="rounded-lg border border-line p-3 text-sm" data-testid="finish-notice">{finishNotice}</p>}
      <ToFinish data={data} onFinish={(id) => void finishReturn(id)} />
      {data.can.readAll ? <OfflineReview /> : null}
      <Sales key={version} data={data} onReceipt={(id) => void showReceipt(id)} onReturn={data.can.return ? setReturning : undefined} />
    </>
  );

  const shell = fullscreen ? 'fixed inset-0 z-[60] flex flex-col gap-3 overflow-y-auto bg-surface-sunken p-3 print:static' : 'flex flex-col gap-3';
  return (
      <div className={shell} data-testid={fullscreen ? 'till-fullscreen' : 'till-inline'}>
        {fullscreen ? null : <PageHeader title="Cash Sales" intro="Ring up a sale at the counter in your open shift: tap what is bought, take the payment (cash with change, M-Pesa or card, or a mix) and give the receipt." />}
        <ShiftBar shift={shift} fullscreen={fullscreen} onSales={() => setShowSales(true)} />
        {canSell && data.offlineEnabled ? <OfflineReady /> : null}
        {canSell ? (
          <section className={`grid min-h-0 gap-3 print:hidden lg:grid-cols-[minmax(0,1fr)_25rem] ${fullscreen ? 'flex-1' : 'lg:h-[calc(100dvh-13rem)] lg:min-h-[34rem]'}`} aria-label="New sale">
            <div className={`${cardClass} flex min-h-[28rem] min-w-0 flex-col`}>
              <ProductArea start={start} problem={startProblem} inCart={inCart} onPick={pick} searchRef={searchRef} />
            </div>
            {desktop ? <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-raised" aria-label="The sale">{cartPane}</aside> : null}
          </section>
        ) : null}
        {canSell && !desktop ? (
          <div className="sticky bottom-0 z-10 print:hidden">
            {held.length === 0 ? null : <button type="button" className="mb-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-amber-500 bg-amber-500/10 px-4 text-sm font-bold text-amber-700" onClick={() => setHolding(true)} data-testid="till-held-bar">On hold <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs text-white">{held.length}</span></button>}
            <button type="button" className="flex min-h-14 w-full items-center justify-between rounded-xl bg-indigo-600 px-5 text-base font-bold text-white shadow-lg" onClick={() => setCartOpen(true)} data-testid="till-open-cart"><span>View sale · {unitCount(cart)} item{unitCount(cart) === 1 ? '' : 's'}</span><span className="font-mono">{totalShown(priced?.total ?? null, cart)}</span></button>
          </div>
        ) : null}
        {fullscreen ? null : salesBlock}
        {canSell && !desktop && cartOpen ? <Modal title="The sale" onClose={() => setCartOpen(false)}><div className="flex max-h-[70dvh] flex-col overflow-hidden rounded-xl border border-line">{cartPane}</div></Modal> : null}
        {canSell && paying && priced !== null && start !== null ? <PayDialog total={priced.total} methods={start.methods} busy={busy} problem={problem} unfinished={unfinished} onPay={(t) => void complete(t)} onClose={() => { if (!busy) setPaying(false); }} /> : null}
        {holding ? <HeldDialog rows={held} busy={busy} problem={heldProblem} onRecall={(id) => void recall(id)} onDiscard={(id) => void giveUp(id)} onClose={() => setHolding(false)} /> : null}
        {receipt === null ? null : <SaleDone sale={receipt} shopName={data.shopName} onClose={() => { setReceipt(null); searchRef.current?.focus(); }} />}
        {showSales ? <Modal title="Sales" wide onClose={() => setShowSales(false)}><div className="space-y-4">{salesBlock}</div></Modal> : null}
        {choosingPackage === null ? null : <QuotePackageDialog money={money} from={PACKAGES} editing={{ productId: choosingPackage, servings: 1, picks: [] }} onClose={() => setChoosingPackage(null)} onChosen={(chosen) => { setCart((c) => addToCart(c, { productId: chosen.productId, name: chosen.summary, listPrice: null, imageUrl: '', quantity: chosen.servings, package: { picks: chosen.picks, note: chosen.note } }, nextKey())); setChoosingPackage(null); }} />}
      </div>
  );
}

/** Keeps this browser ready to go on selling if the connection drops: the offline till and what it needs, refreshed every few minutes while online. */
function OfflineReady() {
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    const run = async () => {
      const r = await prepareOfflineTill();
      if (live) setState(r.ok ? { ok: true, text: `Ready to sell with no connection (kept ${new Date(r.savedAt).toLocaleTimeString()}).` } : { ok: false, text: `Not ready for offline selling: ${r.error}` });
    };
    void run();
    const timer = setInterval(() => void run(), 5 * 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <p className={`text-sm print:hidden ${state?.ok === false ? 'text-amber-700' : 'text-fg-muted'}`} data-testid="offline-ready">
      {state === null ? 'Getting the till ready for offline selling…' : state.text}{' '}
      <Link href={OFFLINE_TILL_PATH} className="underline">Open the offline till</Link>
    </p>
  );
}

function ShiftBar({ shift, fullscreen, onSales }: { shift: CashSalesScreen['shift']; fullscreen: boolean; onSales: () => void }) {
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
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-raised px-4 py-2.5 print:hidden" data-testid="shift-bar">
      <div className="min-w-0">
        <p className="font-semibold break-words text-fg-strong">{shift.registerName}, {shift.branchName}</p>
        <p className="text-xs text-fg-muted">{shift.takings.count} sale(s) so far · the till should hold {kes(shift.expectedCash)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {shift.status === 'closing' ? <Chip tone="amber">Close waiting for approval</Chip> : <Chip tone="green">Shift open</Chip>}
        {fullscreen ? <button type="button" className={buttonClass} onClick={onSales} data-testid="till-sales-button"><ReceiptIcon className="mr-1 size-4" aria-hidden />Sales</button> : null}
        <Link href="/admin/shifts" className={buttonClass}>Shift and reports</Link>
        {fullscreen ? <Link href="/admin" className={buttonClass} data-testid="till-exit"><LogOut className="mr-1 size-4" aria-hidden />Exit</Link> : null}
      </div>
    </div>
  );
}

function ToFinish({ data, onFinish }: { data: CashSalesScreen; onFinish: (returnId: string) => void }) {
  if (data.returns.length === 0) return null;
  return (
    <section className="space-y-2 print:hidden" aria-label="Returns to finish" data-testid="returns-to-finish">
      <h2 className="text-sm font-bold tracking-wider text-fg-subtle uppercase">Returns to finish</h2>
      <ul className="space-y-1 text-sm">{data.returns.map((r) => <li key={r.returnId}>{r.orderNumber} · {kes(r.amount)} · {r.status === 'refund_pending' ? 'refund waiting for approval' : 'refund to be paid'} <button type="button" className={buttonClass} aria-label={`Finish the return of ${r.orderNumber}`} onClick={() => onFinish(r.returnId)}>Finish</button></li>)}</ul>
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
                <p className="font-semibold break-words text-fg-strong">{r.receiptNumber ?? r.orderNumber} · {kes(r.total)}</p>
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
