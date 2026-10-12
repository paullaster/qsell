import Link from 'next/link';
import {
  COMPARE_LABELS,
  COMPARE_MODES,
  PERIOD_PRESETS,
  PERIOD_PRESET_LABELS,
  shiftDate,
} from '@/server/domains/reports/period';
import type { BusinessOverview } from '@/server/domains/reports/types';
import {
  AttentionList,
  Card,
  Delta,
  EmptyNote,
  Kpi,
  SectionFailed,
} from '@/components/admin/overview/parts';
import { OverviewFrame, type FilterState } from '@/components/admin/overview/OverviewFrame';
import { TrendChart } from '@/components/admin/overview/TrendChart';
import {
  formatCount,
  formatDateRange,
  formatInstant,
  formatLocalDate,
  formatMoney,
  formatMoneyShort,
} from '@/components/admin/overview/format';

function filtersFor(data: BusinessOverview, selectedBranchId: string): FilterState {
  const { meta } = data;
  const p = meta.period;
  return {
    preset: p.preset,
    compare: meta.compare.mode,
    branchId: selectedBranchId,
    fromDate: p.fromDate,
    toDate: p.toDate,
    rangeLabel: formatDateRange(p.fromDate, p.toDate),
    compareRangeLabel: formatDateRange(p.previousFromDate, p.previousToDate),
    scopeLabel: meta.scope.label,
    updatedLabel: formatInstant(meta.asOf, p.timeZone),
    presets: PERIOD_PRESETS.filter((x) => x !== 'custom').map((value) => ({
      value,
      label: PERIOD_PRESET_LABELS[value],
    })),
    compareModes: COMPARE_MODES.map((value) => ({ value, label: COMPARE_LABELS[value] })),
    branches: data.branches,
  };
}

export function BusinessOverviewView({
  data,
  selectedBranchId = '',
}: {
  data: BusinessOverview;
  selectedBranchId?: string;
}) {
  const { meta } = data;
  const cur = meta.baseCurrency;
  const m = (n: number) => formatMoney(n, cur);
  const short = (n: number) => formatMoneyShort(n, cur);
  const prevLabel = formatDateRange(meta.period.previousFromDate, meta.period.previousToDate);
  const has = (s: string) => meta.sections.includes(s);
  const failed = (s: string) => meta.failedSections.includes(s);

  const placed = data.sales ? data.sales.flow.reduce((s, f) => s + f.count, 0) : 0;
  const noActivity = data.sales !== null && placed === 0;
  const jump = meta.lastActivityDate
    ? `?${new URLSearchParams({
        period: 'custom',
        from: shiftDate(meta.lastActivityDate, -29),
        to: meta.lastActivityDate,
        compare: meta.compare.mode,
        ...(selectedBranchId ? { branch: selectedBranchId } : {}),
      }).toString()}`
    : null;

  return (
    <OverviewFrame filters={filtersFor(data, selectedBranchId)}>
      {meta.period.notice ? (
        <p
          role="status"
          className="rounded-lg border border-amber-700 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {meta.period.notice}
        </p>
      ) : null}

      {meta.scope.kind === 'none' ? (
        <EmptyNote>
          Your account is not assigned to a branch, so there is nothing to show. Ask an
          administrator to assign you to a branch or give you access to all branches.
        </EmptyNote>
      ) : meta.sections.length === 0 ? (
        <EmptyNote>
          Your role does not include any report permissions, so no figures can be shown for{' '}
          {meta.period.fromDate} to {meta.period.toDate}. Ask an administrator to grant the
          report permissions you need (Reports &amp; Insights).
        </EmptyNote>
      ) : null}

      {data.headline.length > 0 ? (
        <section
          aria-label="Summary"
          className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
        >
          <ul className="space-y-1 text-base font-semibold text-fg-strong sm:text-lg">
            {data.headline.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {noActivity ? (
        <section className="space-y-2 rounded-xl border border-dashed border-line bg-surface-raised p-4 sm:p-5">
          <h2 className="text-sm font-bold text-fg-strong">No orders were placed in this period</h2>
          {meta.lastActivityDate && jump ? (
            <>
              <p className="text-sm text-fg-muted">
                The latest order was on {formatLocalDate(meta.lastActivityDate)}.
              </p>
              <Link
                href={jump}
                className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                Show the 30 days up to {formatLocalDate(meta.lastActivityDate)}
              </Link>
            </>
          ) : (
            <p className="text-sm text-fg-muted">
              There are no orders yet. Figures appear here as soon as the first order comes in.
            </p>
          )}
        </section>
      ) : null}

      {meta.scope.kind !== 'none' ? <AttentionList items={data.attention} /> : null}

      {meta.otherCurrencies.length > 0 ? (
        <p
          role="note"
          className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted"
        >
          Figures are in {cur}. Not included:{' '}
          {meta.otherCurrencies
            .map(
              (o) => `${formatCount(o.orders)} order${o.orders === 1 ? '' : 's'} in ${o.currency}`,
            )
            .join(', ')}
          .
        </p>
      ) : null}

      {has('sales') ? (
        <Card
          id="sales-heading"
          title="Sales"
          definition="Orders placed in the period that were paid, are being paid, or are on credit. Abandoned checkouts, cancelled, failed and refunded orders are not counted."
        >
          {failed('sales') || !data.sales ? (
            <SectionFailed name="Sales" />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi
                  label="Sales"
                  value={short(data.sales.sales.current)}
                  fullValue={m(data.sales.sales.current)}
                  spark={data.sales.trend.map((d) => d.sales)}
                >
                  <Delta value={data.sales.sales} previousLabel={prevLabel} />
                </Kpi>
                <Kpi
                  label="Orders"
                  value={formatCount(data.sales.orders.current)}
                  spark={data.sales.trend.map((d) => d.orders)}
                >
                  <Delta value={data.sales.orders} previousLabel={prevLabel} />
                </Kpi>
                <Kpi
                  label="Average order"
                  value={short(data.sales.averageOrder.current)}
                  fullValue={m(data.sales.averageOrder.current)}
                >
                  <Delta value={data.sales.averageOrder} previousLabel={prevLabel} />
                </Kpi>
                <Kpi
                  label="Tax included in sales"
                  value={short(data.sales.tax.current)}
                  fullValue={m(data.sales.tax.current)}
                />
              </div>

              {data.sales.orders.current > 0 ? (
                <TrendChart
                  trend={data.sales.trend}
                  currency={cur}
                  compareLabel={`${meta.compare.label} (${prevLabel})`}
                />
              ) : null}

              {placed > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-bold tracking-wide text-fg-subtle uppercase">
                    Where this period&apos;s {formatCount(placed)} order{placed === 1 ? '' : 's'}{' '}
                    ended up
                  </h3>
                  <div
                    className="flex h-3 gap-0.5 overflow-hidden rounded-full"
                    role="img"
                    aria-label={data.sales.flow
                      .filter((f) => f.count > 0)
                      .map((f) => `${f.label}: ${f.count}`)
                      .join(', ')}
                  >
                    {data.sales.flow
                      .filter((f) => f.count > 0)
                      .map((f) => (
                        <div
                          key={f.key}
                          className={f.countsAsSale ? 'bg-indigo-500' : 'bg-fg-faint'}
                          style={{ width: `${(f.count / placed) * 100}%` }}
                        />
                      ))}
                  </div>
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {data.sales.flow
                      .filter((f) => f.count > 0)
                      .map((f) => (
                        <li
                          key={f.key}
                          className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
                        >
                          <span
                            className={`inline-block h-2.5 w-2.5 shrink-0 self-center rounded-sm ${f.countsAsSale ? 'bg-indigo-500' : 'bg-fg-faint'}`}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 text-fg-strong">
                            {f.label}
                            <span className="ml-2 text-xs text-fg-subtle">
                              {f.countsAsSale ? 'counted in sales' : 'not in sales'} · {f.hint}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-fg-muted">
                            {formatCount(f.count)} order{f.count === 1 ? '' : 's'}
                          </span>
                          <span className="shrink-0 font-medium text-fg-strong tabular-nums">
                            {m(f.value)}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}

              {data.sales.byBranch ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-bold tracking-wide text-fg-subtle uppercase">
                    Sales by branch
                  </h3>
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full min-w-[28rem] text-left text-sm">
                      <caption className="sr-only">Sales, orders and change by branch</caption>
                      <thead className="bg-surface text-xs text-fg-subtle">
                        <tr>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Branch
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">
                            Sales
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">
                            Share
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">
                            Orders
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">
                            vs {meta.compare.label.toLowerCase()}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.sales.byBranch.map((b) => (
                          <tr key={b.branchId} className="border-t border-line">
                            <th scope="row" className="px-3 py-2 font-medium text-fg-strong">
                              {b.name}
                            </th>
                            <td className="px-3 py-2 text-right tabular-nums">{m(b.sales)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{b.sharePct}%</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatCount(b.orders)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {b.changePct === null
                                ? '—'
                                : `${b.changePct > 0 ? '+' : ''}${b.changePct}%`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {data.sales.topProducts.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-bold tracking-wide text-fg-subtle uppercase">
                    Best sellers by revenue
                  </h3>
                  <ol className="divide-y divide-line rounded-lg border border-line">
                    {data.sales.topProducts.map((p, i) => (
                      <li
                        key={p.productId}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
                      >
                        <span className="w-5 shrink-0 text-xs text-fg-subtle">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-fg-strong">{p.name}</span>
                        <span className="shrink-0 text-xs text-fg-muted">
                          {formatCount(p.units)} sold
                        </span>
                        <span className="shrink-0 font-medium text-fg-strong tabular-nums">
                          {m(p.revenue)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {has('collections') ? (
          <Card
            id="collections-heading"
            title="Money collected"
            definition="Payments confirmed in the period through your payment methods, dated by when each payment was confirmed."
          >
            {failed('collections') || !data.collections ? (
              <SectionFailed name="Money collected" />
            ) : !data.collections.configured ? (
              <div className="space-y-2 rounded-lg border border-dashed border-line px-3 py-4 text-sm text-fg-muted">
                <p>No payment method is set up yet, so there is nothing to collect through.</p>
                <Link
                  href={data.collections.setupHref}
                  className="inline-flex min-h-11 items-center font-semibold text-indigo-400 underline-offset-2 hover:underline"
                >
                  Set up a payment method
                </Link>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Kpi
                    label="Collected"
                    value={short(data.collections.collected.current)}
                    fullValue={m(data.collections.collected.current)}
                  >
                    <Delta value={data.collections.collected} previousLabel={prevLabel} />
                  </Kpi>
                  <Kpi
                    label="Collection rate"
                    value={
                      data.collections.collectionRatePct === null
                        ? '—'
                        : `${data.collections.collectionRatePct}%`
                    }
                    note="Collected ÷ sales in the same period. Can pass 100% when earlier orders are paid now."
                  />
                </div>
                {data.collections.inFlight.pendingCount > 0 ||
                data.collections.inFlight.failedCount > 0 ? (
                  <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted">
                    {data.collections.inFlight.pendingCount > 0
                      ? `${formatCount(data.collections.inFlight.pendingCount)} payment${data.collections.inFlight.pendingCount === 1 ? '' : 's'} (${m(data.collections.inFlight.pendingAmount)}) started but not confirmed. `
                      : ''}
                    {data.collections.inFlight.failedCount > 0
                      ? `${formatCount(data.collections.inFlight.failedCount)} payment attempt${data.collections.inFlight.failedCount === 1 ? '' : 's'} failed, were cancelled or expired.`
                      : ''}
                  </p>
                ) : null}
                <ul className="space-y-3">
                  {data.collections.methods.map((method) => (
                    <li key={method.providerCode} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate font-medium text-fg-strong">
                          {method.name}
                        </span>
                        <span className="shrink-0 text-fg-strong tabular-nums">
                          {m(method.amount)}
                        </span>
                      </div>
                      <div
                        className="h-2 rounded-full bg-surface-sunken"
                        role="meter"
                        aria-label={`${method.name} share of money collected`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={method.sharePct}
                        aria-valuetext={`${method.sharePct}%`}
                      >
                        <div
                          className="h-2 rounded-full bg-indigo-500"
                          style={{ width: `${method.sharePct}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-fg-subtle">
                        {method.sharePct}% · {formatCount(method.count)} payment
                        {method.count === 1 ? '' : 's'}
                      </p>
                    </li>
                  ))}
                </ul>
                {data.collections.unconfigured.count > 0 ? (
                  <p className="rounded-lg border border-amber-700 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    {m(data.collections.unconfigured.amount)} (
                    {formatCount(data.collections.unconfigured.count)} payment
                    {data.collections.unconfigured.count === 1 ? '' : 's'}) came through methods
                    that are no longer set up ({data.collections.unconfigured.providers.join(', ')}
                    ). It is included in the total above.
                  </p>
                ) : null}
                {data.collections.tenders.count > 0 ? (
                  <p className="text-xs text-fg-muted">
                    Not included above: {m(data.collections.tenders.amount)} paid with gift cards
                    and loyalty points ({formatCount(data.collections.tenders.count)} redemption
                    {data.collections.tenders.count === 1 ? '' : 's'}).
                  </p>
                ) : null}
              </>
            )}
          </Card>
        ) : null}

        {has('profit') ? (
          <Card
            id="profit-heading"
            title="Gross profit"
            definition="Sales minus what the products cost when they were sold. Only items with a recorded cost are counted."
          >
            {failed('profit') || !data.profit ? (
              <SectionFailed name="Gross profit" />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Kpi
                  label="Gross profit"
                  value={short(data.profit.grossProfit.current)}
                  fullValue={m(data.profit.grossProfit.current)}
                >
                  <Delta value={data.profit.grossProfit} previousLabel={prevLabel} />
                </Kpi>
                <Kpi
                  label="Margin"
                  value={data.profit.marginPct === null ? '—' : `${data.profit.marginPct}%`}
                  note={
                    data.profit.costCoveragePct === null
                      ? 'No sales in this period.'
                      : data.profit.costCoveragePct < 100
                        ? `Based on the ${data.profit.costCoveragePct}% of sales that have a recorded cost.`
                        : 'Based on all sales.'
                  }
                />
              </div>
            )}
          </Card>
        ) : null}

        {has('receivables') ? (
          <Card
            id="receivables-heading"
            title="Owed by customers"
            definition="Unpaid credit invoices right now (not limited to the period). Overdue means the due date has passed."
          >
            {failed('receivables') || !data.receivables ? (
              <SectionFailed name="Owed by customers" />
            ) : data.receivables.outstanding === 0 ? (
              <EmptyNote>No customer owes you anything.</EmptyNote>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Kpi
                    label="Outstanding"
                    value={short(data.receivables.outstanding)}
                    fullValue={m(data.receivables.outstanding)}
                  />
                  <Kpi
                    label="Overdue"
                    value={short(data.receivables.overdue)}
                    fullValue={m(data.receivables.overdue)}
                    note={`${formatCount(data.receivables.overdueCustomers)} customer${data.receivables.overdueCustomers === 1 ? '' : 's'}`}
                  />
                </div>
                {data.receivables.overdue > 0 ? (
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    {data.receivables.aging.map((a) => (
                      <div
                        key={a.label}
                        className="rounded-lg border border-line bg-surface px-3 py-2"
                      >
                        <dt className="text-fg-subtle">{a.label}</dt>
                        <dd className="font-medium text-fg-strong tabular-nums">{m(a.amount)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <div className="space-y-2">
                  <h3 className="text-xs font-bold tracking-wide text-fg-subtle uppercase">
                    Who owes the most overdue
                  </h3>
                  <ol className="divide-y divide-line rounded-lg border border-line">
                    {data.receivables.topDebtors.map((d) => (
                      <li
                        key={d.customerId}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate text-fg-strong">{d.name}</span>
                        <span className="shrink-0 text-xs text-fg-muted">
                          {m(d.outstanding)} owed
                        </span>
                        <span className="shrink-0 font-medium text-fg-strong tabular-nums">
                          {m(d.overdue)} overdue
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            )}
          </Card>
        ) : null}

        {has('inventory') ? (
          <Card
            id="inventory-heading"
            title="Stock health"
            definition="Active products right now, company-wide. Available stock is on hand minus what is reserved for open orders."
          >
            {failed('inventory') || !data.inventory ? (
              <SectionFailed name="Stock health" />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Kpi
                  label="Out of stock"
                  value={formatCount(data.inventory.outOfStock)}
                  note={`of ${formatCount(data.inventory.activeProducts)} active products`}
                />
                <Kpi
                  label="Running low"
                  value={formatCount(data.inventory.lowStock)}
                  note="At or below the reorder level"
                />
                <Kpi
                  label="Stock value at cost"
                  value={short(data.inventory.stockValueAtCost)}
                  fullValue={m(data.inventory.stockValueAtCost)}
                  note="On-hand units × cost price"
                />
              </div>
            )}
          </Card>
        ) : null}
      </div>

      <details className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-fg-muted">
        <summary className="min-h-8 cursor-pointer py-1 font-semibold text-fg">
          How these numbers were produced
        </summary>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-fg">Read at</dt>
            <dd>{meta.asOf} (UTC)</dd>
          </div>
          <div>
            <dt className="font-semibold text-fg">Period (UTC)</dt>
            <dd>
              {meta.period.from} to {meta.period.to} (end not included)
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-fg">Compared with (UTC)</dt>
            <dd>
              {meta.period.previousFrom} to {meta.period.previousTo}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-fg">Days are cut in</dt>
            <dd>{meta.period.timeZone}</dd>
          </div>
          <div>
            <dt className="font-semibold text-fg">Scope</dt>
            <dd>{meta.scope.label}</dd>
          </div>
          <div>
            <dt className="font-semibold text-fg">Currency</dt>
            <dd>{cur}</dd>
          </div>
          <div>
            <dt className="font-semibold text-fg">Definitions version</dt>
            <dd>{meta.definitionsVersion}</dd>
          </div>
          <div>
            <dt className="font-semibold text-fg">Freshness</dt>
            <dd>
              {meta.cached
                ? 'Shared with a read from the last 15 seconds.'
                : 'Read live from the database.'}
            </dd>
          </div>
        </dl>
        <p className="mt-3">
          The page address holds the period, comparison and branch. Open it again to repeat this
          view; figures change only if records changed since.
        </p>
      </details>
    </OverviewFrame>
  );
}
