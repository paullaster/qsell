'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { getInsightsAction, type InsightsData } from '@/server/domains/pricing/insights-actions';
import type { Finding, Severity } from '@/server/domains/pricing/insights-service';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  cardClass,
  fieldClass,
  type Message,
} from '../approvals/shared';
import { money } from './DiscountsClient';

const SEVERITY: Record<Severity, { tone: 'red' | 'amber' | 'grey'; label: string }> = {
  high: { tone: 'red', label: 'Needs attention' },
  medium: { tone: 'amber', label: 'Worth a look' },
  low: { tone: 'grey', label: 'For your information' },
};

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
];

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`${cardClass} !p-3`}>
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-1 text-xl font-bold text-fg-strong">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-fg-muted">{hint}</p> : null}
    </div>
  );
}

function Table({
  caption,
  head,
  children,
  empty,
  isEmpty,
}: {
  caption: string;
  head: Array<{ label: string; right?: boolean }>;
  children: React.ReactNode;
  empty: string;
  isEmpty: boolean;
}) {
  if (isEmpty) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-fg-muted">
            {head.map((h) => (
              <th
                key={h.label}
                className={`py-2 pr-3 font-semibold ${h.right ? 'text-right' : ''}`}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const td = 'py-2 pr-3 align-top';
const num = `${td} text-right font-mono`;

function FindingRow({ f }: { f: Finding }) {
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Chip>
        <span className="text-sm font-semibold text-fg-strong">
          {f.title} <span className="font-normal text-fg-muted">({f.count.toLocaleString()})</span>
        </span>
      </div>
      <p className="text-sm text-fg">{f.detail}</p>
      {f.examples.length > 0 ? (
        <p className="text-xs text-fg-muted">For example: {f.examples.join(', ')}</p>
      ) : null}
      {f.href ? (
        <Link
          href={f.href}
          className="inline-flex min-h-10 items-center text-sm text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          Open
        </Link>
      ) : null}
    </li>
  );
}

export function InsightsClient({
  initial,
  branches,
}: {
  initial: InsightsData;
  branches: Array<{ id: string; name: string }>;
}) {
  const uid = useId();
  const [data, setData] = useState(initial);
  const [days, setDays] = useState(initial.days);
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  useEffect(() => {
    if (days === initial.days && !branchId) {
      setData(initial);
      return;
    }
    let live = true;
    setBusy(true);
    void getInsightsAction({ days, branchId: branchId || null }).then((r) => {
      if (!live) return;
      setBusy(false);
      if (r.ok) {
        setData(r.data);
        setMessage(null);
      } else setMessage({ kind: 'error', text: r.error });
    });
    return () => {
      live = false;
    };
  }, [days, branchId, initial]);

  const o = data.overview;
  const L = data.liabilities;
  return (
    <div className="space-y-5">
      <PageHeader title="Insights">
        How pricing is doing: sales and margin, what promotions cost, who is overriding prices,
        where one product sells for different prices, what is owed to customers, and what looks
        wrong. Every figure comes from what was recorded when the sale happened.
      </PageHeader>

      <div className="flex flex-wrap gap-3">
        <div>
          <label htmlFor={`${uid}-p`} className="mb-1 block text-xs font-semibold text-fg">
            Period
          </label>
          <select
            id={`${uid}-p`}
            className={`${fieldClass} w-48`}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {PERIODS.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-b`} className="mb-1 block text-xs font-semibold text-fg">
            Branch (sales figures)
          </label>
          <select
            id={`${uid}-b`}
            className={`${fieldClass} w-56`}
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        {busy ? (
          <p role="status" className="self-end pb-2 text-sm text-fg-muted">
            Updating…
          </p>
        ) : null}
      </div>
      <Notice message={message} />

      <section aria-label="Sales and margin" className="space-y-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Orders" value={o.orders.toLocaleString()} />
          <Kpi label="Net sales (tax left out)" value={money(o.netSales)} />
          <Kpi
            label="Gross margin"
            value={o.grossMarginPercent == null ? 'Not known' : `${o.grossMarginPercent}%`}
            hint={`Cost kept for ${o.costCoveragePercent}% of sales`}
          />
          <Kpi
            label="Given away in discounts"
            value={money(o.discountsGiven)}
            hint={o.giftCost > 0 ? `Plus ${money(o.giftCost)} of free gifts at cost` : undefined}
          />
        </div>
        {o.costCoveragePercent < 100 && o.netSales > 0 ? (
          <p className="text-xs text-fg-muted">
            Orders from before cost was kept with each sale have no cost, so margin is worked out on
            the sales that do.
          </p>
        ) : null}
        <div className={`${cardClass} space-y-2`}>
          <h2 className="text-sm font-bold text-fg-strong">By day</h2>
          <Table
            caption="Sales by day"
            head={[
              { label: 'Day' },
              { label: 'Orders', right: true },
              { label: 'Net sales', right: true },
              { label: 'Margin', right: true },
            ]}
            empty="No sales in this period."
            isEmpty={o.daily.length === 0}
          >
            {o.daily
              .slice(-31)
              .reverse()
              .map((d) => (
                <tr key={d.day} className="border-b border-line/60">
                  <td className={td}>{d.day}</td>
                  <td className={num}>{d.orders}</td>
                  <td className={num}>{money(d.netSales)}</td>
                  <td className={num}>{d.marginPercent == null ? '–' : `${d.marginPercent}%`}</td>
                </tr>
              ))}
          </Table>
          {o.daily.length > 31 ? (
            <p className="text-xs text-fg-muted">The latest 31 days are shown.</p>
          ) : null}
        </div>
      </section>

      <section aria-label="What looks wrong" className={`${cardClass} space-y-1`}>
        <h2 className="text-sm font-bold text-fg-strong">What looks wrong</h2>
        {data.findings.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing to flag right now.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.findings.map((f) => (
              <FindingRow key={f.code} f={f} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Promotions" className={`${cardClass} space-y-2`}>
        <h2 className="text-sm font-bold text-fg-strong">What promotions cost</h2>
        <Table
          caption="Promotions in the period"
          head={[
            { label: 'Rule' },
            { label: 'Orders', right: true },
            { label: 'Given away', right: true },
            { label: 'Sales on those orders', right: true },
            { label: 'Margin', right: true },
            { label: 'Budget used', right: true },
          ]}
          empty="No discount was used in this period."
          isEmpty={data.promotions.length === 0}
        >
          {data.promotions.map((p) => (
            <tr key={p.ruleId} className="border-b border-line/60">
              <td className={td}>
                <Link
                  href={`/admin/pricing/discounts/${p.ruleId}`}
                  className="font-semibold text-indigo-700 hover:underline"
                >
                  {p.name}
                </Link>{' '}
                <span className="text-xs text-fg-muted">{p.code}</span>
              </td>
              <td className={num}>{p.orders}</td>
              <td className={num}>{money(p.given)}</td>
              <td className={num}>{money(p.netSales)}</td>
              <td className={num}>{p.marginPercent == null ? '–' : `${p.marginPercent}%`}</td>
              <td
                className={`${num} ${p.budgetBurnPercent != null && p.budgetBurnPercent >= 90 ? 'text-red-700' : ''}`}
              >
                {p.budgetBurnPercent == null
                  ? '–'
                  : `${p.budgetBurnPercent}% of ${money(p.budget ?? 0)}`}
              </td>
            </tr>
          ))}
        </Table>
      </section>

      <section aria-label="Overrides" className={`${cardClass} space-y-3`}>
        <h2 className="text-sm font-bold text-fg-strong">Overrides and floor breaches</h2>
        <p className="text-sm text-fg">
          Orders: {data.guard.belowFloor.toLocaleString()} of{' '}
          {data.guard.orderLines.toLocaleString()} lines sold below their floor,{' '}
          {data.guard.overLimit.toLocaleString()} past a seller&apos;s override limit.
        </p>
        <Table
          caption="Quotes by seller"
          head={[
            { label: 'Seller' },
            { label: 'Quotes', right: true },
            { label: 'Below floor', right: true },
            { label: 'Past their limit', right: true },
            { label: 'Average override', right: true },
          ]}
          empty="No quotes in this period."
          isEmpty={data.guard.quotes.length === 0}
        >
          {data.guard.quotes.map((q) => (
            <tr key={q.userId ?? q.name} className="border-b border-line/60">
              <td className={td}>{q.name}</td>
              <td className={num}>{q.quotes}</td>
              <td className={num}>{q.belowFloor}</td>
              <td className={num}>{q.overLimit}</td>
              <td className={num}>
                {q.averageOverridePercent ? `${q.averageOverridePercent}%` : '–'}
              </td>
            </tr>
          ))}
        </Table>
      </section>

      <section aria-label="Price variance" className={`${cardClass} space-y-2`}>
        <h2 className="text-sm font-bold text-fg-strong">The same product at different prices</h2>
        <p className="text-xs text-fg-muted">
          Products sold in two or more branches, widest gap first. Tax is left out.
        </p>
        {data.variance.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No product sold at different prices in different branches.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {data.variance.map((v) => (
              <li key={v.productId} className="py-2 text-sm">
                <span className="font-semibold text-fg-strong">{v.name}</span>{' '}
                <span className="text-xs text-fg-muted">{v.sku}</span> ·{' '}
                <strong>{v.spreadPercent}%</strong> apart
                <span className="block text-xs text-fg-muted">
                  {v.branches.map((b) => `${b.branch} ${money(b.unitPrice)}`).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Owed to customers" className={`${cardClass} space-y-3`}>
        <h2 className="text-sm font-bold text-fg-strong">Owed to customers</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Kpi
            label="Gift cards outstanding"
            value={money(L.giftCards.outstanding)}
            hint={`${L.giftCards.cards.toLocaleString()} cards with a balance${L.giftCards.expiredWithBalance > 0 ? ` · ${money(L.giftCards.expiredWithBalance)} expired` : ''}`}
          />
          <Kpi
            label="Loyalty points outstanding"
            value={L.loyalty ? L.loyalty.points.toLocaleString() : 'No programme'}
            hint={
              L.loyalty
                ? `Worth ${money(L.loyalty.worth)} · ${L.loyalty.accounts.toLocaleString()} customers${L.loyalty.active ? '' : ' · paused'}`
                : undefined
            }
          />
        </div>
        {L.rebates.length === 0 ? (
          <EmptyState title="No rebate programmes in force">
            Rebates earned and not yet paid appear here.
          </EmptyState>
        ) : (
          <Table
            caption="Rebates earned"
            head={[
              { label: 'Programme' },
              { label: 'Earned, not paid', right: true },
              { label: 'Waiting for approval', right: true },
              { label: 'Paid so far', right: true },
            ]}
            empty=""
            isEmpty={false}
          >
            {L.rebates.map((r) => (
              <tr key={r.programId} className="border-b border-line/60">
                <td className={td}>
                  <Link
                    href={`/admin/pricing/rebates/${r.programId}`}
                    className="font-semibold text-indigo-700 hover:underline"
                  >
                    {r.name}
                  </Link>{' '}
                  <span className="text-xs text-fg-muted">{r.code}</span>
                  {r.truncated ? (
                    <span className="block text-xs text-amber-700">
                      Counted over the first 50,000 customer periods only.
                    </span>
                  ) : null}
                </td>
                <td className={num}>{money(r.accrued)}</td>
                <td className={num}>{money(r.waiting)}</td>
                <td className={num}>{money(r.paid)}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="text-xs text-fg-muted">
          These are not posted to the financial ledger yet; the accounting rules for them are not
          decided.
        </p>
      </section>
    </div>
  );
}
