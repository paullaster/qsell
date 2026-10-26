'use client';

import { Suspense, use, useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { type commitmentsAction, performanceAction, pettyCashReportAction, purchasesAction, qualificationAction, sourcingAction, watchListAction, withholdingReportAction } from '@/server/domains/vendors/insights-actions';
import { fromCents } from '@/lib/vendor-payment';
import { showPercent } from '@/lib/vendor-insights';
import { Field, LoadFailed, PageHeader, attempt, cardClass, fieldClass } from '@/components/ui/screen-kit';

type Tab = 'commitments' | 'performance' | 'purchases' | 'sourcing' | 'withholding' | 'qualification' | 'petty' | 'watch';
const TABS: { key: Tab; label: string }[] = [
  { key: 'commitments', label: 'Commitments' },
  { key: 'performance', label: 'Performance' },
  { key: 'purchases', label: 'Purchases' },
  { key: 'sourcing', label: 'Quotations' },
  { key: 'withholding', label: 'Tax withheld' },
  { key: 'qualification', label: 'Qualification' },
  { key: 'petty', label: 'Petty cash' },
  { key: 'watch', label: 'Watch list' },
];

type Commitments = Extract<Awaited<ReturnType<typeof commitmentsAction>>, { ok: true }>['data'];

export function VendorReportsClient({ commitmentsPromise }: { commitmentsPromise: ReturnType<typeof commitmentsAction> }) {
  const first = use(commitmentsPromise);
  const [tab, setTab] = useState<Tab>('commitments');
  if (!first.ok) return <LoadFailed error={first.error} />;
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Vendor reports" intro="What we have committed to buy, how vendors perform, what was bought, and things worth a second look." />
      <p className="text-xs text-fg-muted">Documents that are expiring or have expired are on <Link href="/admin/vendors/expiring" className="font-semibold underline">their own list</Link>. What we owe is on <Link href="/admin/vendors/payables" className="font-semibold underline">the payables page</Link>.</p>
      <div role="tablist" aria-label="Reports" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`min-h-10 rounded-lg border px-3 text-sm font-semibold ${tab === t.key ? 'border-fg-strong bg-fg-strong text-bg' : 'border-line text-fg'}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.key === tab)?.label}>
        {tab === 'commitments' ? <CommitmentsView data={first.data} /> : null}
        {tab === 'performance' ? <Ranged load={performanceAction} render={(d) => <PerformanceView data={d} />} /> : null}
        {tab === 'purchases' ? <Ranged load={purchasesAction} render={(d) => <PurchasesView data={d} />} /> : null}
        {tab === 'sourcing' ? <Ranged load={sourcingAction} render={(d) => <SourcingView data={d} />} /> : null}
        {tab === 'withholding' ? <Ranged load={withholdingReportAction} render={(d) => <WithholdingView data={d} />} /> : null}
        {tab === 'qualification' ? <Ranged load={() => qualificationAction()} render={(d) => <QualificationView data={d} />} /> : null}
        {tab === 'petty' ? <Ranged load={pettyCashReportAction} render={(d) => <PettyView data={d} />} /> : null}
        {tab === 'watch' ? <Ranged load={watchListAction} render={(d) => <WatchView data={d} />} /> : null}
      </div>
    </div>
  );
}

/** Loads a report for a date range when shown, and again when the range changes. */
function Ranged<T>({ load, render }: { load: (from?: string, to?: string) => Promise<{ ok: true; data: T } | { ok: false; error: string }>; render: (data: T) => ReactNode }) {
  const uid = useId();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pending, setPending] = useState(() => attempt(load()));
  const change = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
    setPending(attempt(load(f === '' ? undefined : f, t === '' ? undefined : t)));
  };
  return (
    <div className="space-y-4">
      <div className={`${cardClass} flex flex-wrap items-end gap-3`}>
        <Field id={`${uid}-f`} label="From"><input id={`${uid}-f`} type="date" value={from} onChange={(e) => change(e.target.value, to)} className={fieldClass} /></Field>
        <Field id={`${uid}-t`} label="To"><input id={`${uid}-t`} type="date" value={to} onChange={(e) => change(from, e.target.value)} className={fieldClass} /></Field>
        <p className="text-xs text-fg-muted">Empty dates mean the last year.</p>
      </div>
      <div aria-live="polite">
        <Suspense fallback={<p className="text-sm text-fg-muted">Loading…</p>}>
          <Shown pending={pending} render={render} />
        </Suspense>
      </div>
    </div>
  );
}

function Shown<T>({ pending, render }: { pending: Promise<{ ok: true; data: T } | { ok: false; error: string }>; render: (data: T) => ReactNode }) {
  const res = use(pending);
  return res.ok ? <>{render(res.data)}</> : <p role="alert" className="text-sm text-red-700">{res.error}</p>;
}

interface Col<R> { head: string; cell: (r: R) => ReactNode; right?: boolean }

/** Cards on a phone, a table from md; the first column names the row. */
function Rows<R>({ label, rows, cols, keyOf, empty }: { label: string; rows: R[]; cols: Col<R>[]; keyOf: (r: R) => string; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-fg-muted">{empty}</p>;
  const [name, ...rest] = cols;
  return (
    <>
      <ul className="space-y-2 md:hidden" aria-label={label}>
        {rows.map((r) => (
          <li key={keyOf(r)} className={cardClass}>
            <p className="text-sm font-bold text-fg-strong">{name?.cell(r)}</p>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">{rest.map((c) => <div key={c.head}><dt className="text-fg-muted">{c.head}</dt><dd className="font-medium tabular-nums text-fg">{c.cell(r)}</dd></div>)}</dl>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <table className="w-full text-sm" aria-label={label}>
          <thead><tr className="text-left text-xs text-fg-muted">{cols.map((c) => <th key={c.head} className={`py-2 pr-3 ${c.right === true ? 'text-right' : ''}`}>{c.head}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">{rows.map((r) => <tr key={keyOf(r)}>{cols.map((c) => <td key={c.head} className={`py-2 pr-3 ${c.right === true ? 'text-right tabular-nums' : ''}`}>{c.cell(r)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </>
  );
}

const money = (cents: number) => fromCents(cents);

function CommitmentsView({ data }: { data: Commitments }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">Open orders: ordered <span className="font-semibold">{money(data.totals.orderedCents)}</span> · still to come in and be invoiced <span className="font-semibold">{money(data.totals.openCents)}</span> · received, not yet invoiced <span className="font-semibold">{money(data.totals.receivedNotInvoicedCents)}</span></p>
      <Rows
        label="Commitments by vendor"
        rows={data.lines}
        keyOf={(r) => `${r.vendorId}-${r.currency}`}
        empty="There are no open orders."
        cols={[
          { head: 'Vendor', cell: (r) => `${r.name} (${r.currency})` },
          { head: 'Orders', cell: (r) => String(r.orders), right: true },
          { head: 'Ordered', cell: (r) => money(r.orderedCents), right: true },
          { head: 'Received', cell: (r) => money(r.receivedCents), right: true },
          { head: 'Invoiced', cell: (r) => money(r.invoicedCents), right: true },
          { head: 'Received, not invoiced', cell: (r) => money(r.receivedNotInvoicedCents), right: true },
          { head: 'Still open', cell: (r) => money(r.openCents), right: true },
        ]}
      />
    </div>
  );
}

type Performance = Extract<Awaited<ReturnType<typeof performanceAction>>, { ok: true }>['data'];
function PerformanceView({ data }: { data: Performance }) {
  return (
    <Rows
      label="Vendor performance"
      rows={data.lines}
      keyOf={(r) => r.vendorId}
      empty="Nothing was delivered, invoiced or asked for in this period."
      cols={[
        { head: 'Vendor', cell: (r) => r.name },
        { head: 'Deliveries', cell: (r) => String(r.deliveries), right: true },
        { head: 'On time', cell: (r) => showPercent(r.onTimePercent), right: true },
        { head: 'Goods rejected', cell: (r) => showPercent(r.rejectedPercent), right: true },
        { head: 'Invoice lines that matched', cell: (r) => showPercent(r.accuratePercent), right: true },
        { head: 'Quotation requests answered', cell: (r) => showPercent(r.respondedPercent), right: true },
      ]}
    />
  );
}

type Purchases = Extract<Awaited<ReturnType<typeof purchasesAction>>, { ok: true }>['data'];
function PurchasesView({ data }: { data: Purchases }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">Booked between {data.range.from} and {data.range.to}: <span className="font-semibold">{money(data.totalCents)}</span></p>
      <Rows
        label="Purchases by vendor"
        rows={data.lines}
        keyOf={(r) => `${r.vendorId}-${r.currency}`}
        empty="No invoices were booked in this period."
        cols={[
          { head: 'Vendor', cell: (r) => `${r.name} (${r.currency})` },
          { head: 'Invoices', cell: (r) => String(r.invoices), right: true },
          { head: 'Before tax', cell: (r) => money(r.subtotalCents), right: true },
          { head: 'Tax', cell: (r) => money(r.taxCents), right: true },
          { head: 'Total', cell: (r) => money(r.totalCents), right: true },
        ]}
      />
    </div>
  );
}

type Watch = Extract<Awaited<ReturnType<typeof watchListAction>>, { ok: true }>['data'];
function WatchView({ data }: { data: Watch }) {
  const none = data.duplicateInvoices.length + data.sharedBankAccounts.length + data.newVendorPayments.length + data.overriddenOrders.length === 0 && data.taxWithoutEtims.length === 0;
  return (
    <div className="space-y-5">
      <p className="text-xs text-fg-muted">These are things to look at, not mistakes. Nothing here blocks or changes a document. The limits are set under <Link href="/admin/vendors/settings" className="font-semibold underline">Ordering rules</Link>; a flagged payment also needs three people to approve and pay it, when that rule is on.</p>
      {none ? <p className="text-sm text-fg-muted" role="status">Nothing needs a second look in this period.</p> : null}
      {data.duplicateInvoices.length === 0 ? null : (
        <section aria-label="Invoices that look alike" className="space-y-2">
          <h2 className="text-sm font-bold text-fg-strong">Invoices that look alike</h2>
          <p className="text-xs text-fg-muted">Same vendor and same total, dated within {data.settings.duplicateWindowDays} days of each other.</p>
          <Rows label="Look-alike invoices" rows={data.duplicateInvoices} keyOf={(r) => `${r.first}-${r.second}`} empty="" cols={[{ head: 'Vendor', cell: (r) => r.vendor }, { head: 'Invoices', cell: (r) => `${r.first} and ${r.second}` }, { head: 'Total', cell: (r) => money(r.totalCents), right: true }, { head: 'Days apart', cell: (r) => String(r.daysApart), right: true }]} />
        </section>
      )}
      {data.sharedBankAccounts.length === 0 ? null : (
        <section aria-label="Bank accounts shared by vendors" className="space-y-2">
          <h2 className="text-sm font-bold text-fg-strong">Bank accounts shared by vendors</h2>
          <Rows label="Shared bank accounts" rows={data.sharedBankAccounts} keyOf={(r) => `${r.last4}-${r.vendors.join(',')}`} empty="" cols={[{ head: 'Account ending', cell: (r) => r.last4 }, { head: 'Vendors', cell: (r) => r.vendors.join(', ') }]} />
        </section>
      )}
      {data.newVendorPayments.length === 0 ? null : (
        <section aria-label="Large payments to new vendors" className="space-y-2">
          <h2 className="text-sm font-bold text-fg-strong">Large payments to new vendors</h2>
          <p className="text-xs text-fg-muted">Paid within {data.settings.newVendorDays} days of the vendor being added, {money(data.settings.newVendorAmountCents)} or more.</p>
          <Rows label="New vendor payments" rows={data.newVendorPayments} keyOf={(r) => r.number ?? r.vendor} empty="" cols={[{ head: 'Vendor', cell: (r) => r.vendor }, { head: 'Voucher', cell: (r) => r.number ?? '' }, { head: 'Paid on', cell: (r) => r.paidOn ?? '' }, { head: 'Vendor age (days)', cell: (r) => String(r.vendorAgeDays), right: true }, { head: 'Amount', cell: (r) => money(r.amountCents), right: true }]} />
        </section>
      )}
      {data.taxWithoutEtims.length === 0 ? null : (
        <section aria-label="Invoices with tax and no eTIMS number" className="space-y-2">
          <h2 className="text-sm font-bold text-fg-strong">Invoices with tax and no eTIMS number</h2>
          <p className="text-xs text-fg-muted">The input tax on these may not be claimable. Ask the vendor for an eTIMS invoice.</p>
          <Rows label="Tax without eTIMS" rows={data.taxWithoutEtims} keyOf={(r) => r.number} empty="" cols={[{ head: 'Booked invoice', cell: (r) => `${r.number} · ${r.vendor}` }, { head: 'Vendor’s number', cell: (r) => r.vendorInvoiceNo }, { head: 'Posted', cell: (r) => r.postingDate }, { head: 'Tax', cell: (r) => money(r.taxCents), right: true }]} />
        </section>
      )}
      {data.overriddenOrders.length === 0 ? null : (
        <section aria-label="Orders raised with a rule set aside" className="space-y-2">
          <h2 className="text-sm font-bold text-fg-strong">Orders raised with a rule set aside</h2>
          <p className="text-xs text-fg-muted">No request for quotation, or a vendor not qualified for the category.</p>
          <Rows label="Overridden orders" rows={data.overriddenOrders} keyOf={(r) => r.number ?? r.vendor} empty="" cols={[{ head: 'Order', cell: (r) => `${r.number ?? ''} · ${r.vendor}` }, { head: 'Date', cell: (r) => r.orderDate }, { head: 'Total', cell: (r) => money(r.totalCents), right: true }, { head: 'Reason given', cell: (r) => r.reason }]} />
        </section>
      )}
    </div>
  );
}

type Sourcing = Extract<Awaited<ReturnType<typeof sourcingAction>>, { ok: true }>['data'];
function SourcingView({ data }: { data: Sourcing }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">Awarded between {data.range.from} and {data.range.to}: {data.averageCycleDays === null ? 'no cycle time to show' : <>on average <span className="font-semibold">{String(data.averageCycleDays)} days</span> from issue to award</>} · saved against the dearest quote <span className="font-semibold">{money(data.savedAgainstHighestCents)}</span></p>
      <Rows
        label="Awarded requests for quotation"
        rows={data.lines}
        keyOf={(r) => r.id}
        empty="No request for quotation was awarded in this period."
        cols={[
          { head: 'Request', cell: (r) => `${r.number ?? ''} ${r.title}`.trim() },
          { head: 'Days to award', cell: (r) => (r.cycleDays === null ? '—' : String(r.cycleDays)), right: true },
          { head: 'Awarded', cell: (r) => `${money(r.awardedCents)} ${r.currency}`, right: true },
          { head: 'Saved vs dearest quote', cell: (r) => money(r.savedAgainstHighestCents), right: true },
          { head: 'Under the estimate', cell: (r) => (r.savedAgainstEstimateCents === null ? 'No estimate' : money(r.savedAgainstEstimateCents)), right: true },
        ]}
      />
    </div>
  );
}

type Withholding = Extract<Awaited<ReturnType<typeof withholdingReportAction>>, { ok: true }>['data'];
function WithholdingView({ data }: { data: Withholding }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">Withheld between {data.range.from} and {data.range.to}: <span className="font-semibold">{money(data.totalCents)}</span></p>
      <Rows
        label="Tax withheld"
        rows={data.lines}
        keyOf={(r) => `${r.period}-${r.vendor}-${r.code}-${r.currency}`}
        empty="No tax was withheld in this period."
        cols={[
          { head: 'Month', cell: (r) => r.period },
          { head: 'Vendor', cell: (r) => r.vendor },
          { head: 'Kind', cell: (r) => r.code },
          { head: 'Certificates', cell: (r) => String(r.certificates), right: true },
          { head: 'Paid on', cell: (r) => `${money(r.baseCents)} ${r.currency}`, right: true },
          { head: 'Withheld', cell: (r) => money(r.amountCents), right: true },
        ]}
      />
    </div>
  );
}

type Qualification = Extract<Awaited<ReturnType<typeof qualificationAction>>, { ok: true }>['data'];
const QUALIFICATION_WORDS: [string, string][] = [['approved', 'Qualified'], ['submitted', 'Waiting'], ['in_review', 'In review'], ['revision_requested', 'Sent back'], ['suspended', 'Suspended'], ['rejected', 'Refused'], ['expired', 'Expired'], ['revoked', 'Revoked']];
function QualificationView({ data }: { data: Qualification }) {
  return (
    <Rows
      label="Qualification by category"
      rows={data.lines}
      keyOf={(r) => r.category}
      empty="No vendor has applied to be qualified yet."
      cols={[{ head: 'Category', cell: (r) => r.category }, ...QUALIFICATION_WORDS.map(([key, label]): Col<(typeof data.lines)[number]> => ({ head: label, cell: (r) => String(r.counts[key] ?? 0), right: true }))]}
    />
  );
}

type Petty = Extract<Awaited<ReturnType<typeof pettyCashReportAction>>, { ok: true }>['data'];
function PettyView({ data }: { data: Petty }) {
  return (
    <Rows
      label="Petty cash"
      rows={data.lines}
      keyOf={(r) => r.floatId}
      empty="There are no petty cash floats."
      cols={[
        { head: 'Float', cell: (r) => `${r.name} (${r.code})` },
        { head: 'Vouchers paid', cell: (r) => String(r.vouchers), right: true },
        { head: 'Reversed', cell: (r) => String(r.reversed), right: true },
        { head: 'Paid out', cell: (r) => `${money(r.spentCents)} ${r.currency}`, right: true },
        { head: 'Topped up', cell: (r) => money(r.toppedUpCents), right: true },
        { head: 'Cash now', cell: (r) => money(r.balanceCents), right: true },
        { head: 'Not yet covered', cell: (r) => String(r.notYetCoveredVouchers), right: true },
      ]}
    />
  );
}
