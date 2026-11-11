'use client';

import { use, useState } from 'react';
import { deliveryReportAction } from '@/server/domains/delivery/cost-actions';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Loaded = Awaited<ReturnType<typeof deliveryReportAction>>;
type Report = Extract<Loaded, { ok: true }>['data'];

export function DeliveryReportClient({ reportPromise }: { reportPromise: ReturnType<typeof deliveryReportAction> }) {
  const res: Loaded = use(reportPromise);
  return res.ok ? <Screen initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Screen({ initial }: { initial: Report }) {
  const [report, setReport] = useState(initial);
  const [from, setFrom] = useState(initial.period.from);
  const [to, setTo] = useState(initial.period.to);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const apply = async () => {
    setBusy(true);
    setNotice(null);
    const r = await attempt(deliveryReportAction({ from, to }));
    setBusy(false);
    if (r.ok) setReport(r.data);
    else setNotice({ kind: 'error', text: r.error });
  };
  const losing = Number(report.margin) < 0;
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Delivery report" intro="What delivery earned and what it cost over the days you choose. A delivery counts on the day it was delivered; the customer's delivery charge (before tax) counts once for an order." />
      <Message notice={notice} />
      <form
        aria-label="Days"
        className={`${cardClass} grid grid-cols-1 items-end gap-3 sm:grid-cols-3`}
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <Field id="report-from" label="From day">
          <input id="report-from" type="date" className={fieldClass} value={from} onChange={(e) => setFrom(e.target.value)} required />
        </Field>
        <Field id="report-to" label="To day">
          <input id="report-to" type="date" className={fieldClass} value={to} onChange={(e) => setTo(e.target.value)} required />
        </Field>
        <button type="submit" className={primaryClass} disabled={busy}>
          {busy ? 'Working…' : 'Show these days'}
        </button>
      </form>

      <section aria-label="Margin" className={`${cardClass} space-y-3`}>
        <h3 className="text-sm font-bold text-fg-strong">
          {report.period.from} to {report.period.to}
        </h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Delivered" value={String(report.delivered)} />
          <Stat label="Customers paid for delivery" value={`KSh ${report.charge}`} />
          <Stat label="Delivery cost" value={`KSh ${report.cost}`} hint={`Rider pay ${report.riderPay} · courier ${report.courierCharges} · fuel ${report.fuelCosts} · vehicles ${report.vehicleCosts} · other ${report.otherCosts}`} />
          <Stat label="Margin" value={`KSh ${report.margin}`} hint={report.marginPercent === null ? 'No delivery charge in these days' : `${String(report.marginPercent)}% of what customers paid`} tone={losing ? 'bad' : 'good'} />
        </dl>
        <p className="text-xs text-fg-muted">
          {report.failedAttempts} {report.failedAttempts === 1 ? 'attempt' : 'attempts'} did not get through and {report.partlyTaken} {report.partlyTaken === 1 ? 'delivery was' : 'deliveries were'} taken only in part.
        </p>
      </section>

      <Table
        label="By rider"
        empty="No rider worked in these days."
        head={['Rider', 'Delivered', 'Did not get through', 'Pay earned']}
        rows={report.byRider.map((r) => [r.name, String(r.delivered), String(r.failed), `KSh ${r.pay}`])}
      />
      <Table label="By courier" empty="No courier charged anything in these days." head={['Courier', 'Deliveries', 'Charged']} rows={report.byCourier.map((r) => [r.courier, String(r.deliveries), `KSh ${r.charged}`])} />
      <Table
        label="By zone"
        empty="Nothing was delivered in these days."
        head={['Zone', 'Delivered', 'Customers paid', 'Direct cost']}
        rows={report.byZone.map((r) => [r.zone, String(r.delivered), `KSh ${r.charge}`, `KSh ${r.directCost}`])}
        note="Direct cost is pay for a delivery and a courier's charge. Pay for a day on a run belongs to the rider, not to a zone."
      />
      <Table
        label="By vehicle"
        empty="No vehicle from the Vehicles list ran a delivery or had a running cost in these days."
        head={['Vehicle', 'Delivered', 'Running costs', 'Cost per delivery']}
        rows={report.byVehicle.map((v) => [
          v.name,
          `${String(v.delivered)} on ${String(v.runs)} ${v.runs === 1 ? 'run' : 'runs'}`,
          `KSh ${v.total} (fuel ${v.fuel}, repairs ${v.repairs}, other ${v.other})`,
          v.perDelivery === null ? 'Nothing delivered' : `KSh ${v.perDelivery}`,
        ])}
        note={`Running costs are fuel, vehicle costs and other costs typed against a vehicle (or against a run that went out in it). A delivery counts for the vehicle of the run it was delivered on.${Number(report.untiedRunningCosts) === 0 ? '' : ` Running costs not tied to any vehicle in these days: KSh ${report.untiedRunningCosts}.`}`}
      />
      <Table label="Why attempts failed" empty="No attempt failed in these days." head={['Reason', 'Attempts']} rows={report.failures.map((f) => [f.words, String(f.count)])} />
      <Table label="Cash riders hold now" empty="No rider holds cash." head={['Rider', 'Holds']} rows={report.cashHeld.map((h) => [h.name, `KSh ${h.balance}`])} note="Not limited to the days above: this is what they hold today, until it is handed in." />
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="space-y-0.5 rounded-lg border border-line bg-surface p-3">
      <dt className="text-xs font-semibold text-fg-muted">{label}</dt>
      <dd className={`text-xl font-bold ${tone === 'bad' ? 'text-red-700 dark:text-red-300' : 'text-fg-strong'}`}>{value}</dd>
      {hint === undefined ? null : <dd className="text-xs text-fg-muted">{hint}</dd>}
      {tone === 'bad' ? <Chip tone="red">Delivery lost money</Chip> : null}
    </div>
  );
}

function Table({ label, head, rows, empty, note }: { label: string; head: string[]; rows: string[][]; empty: string; note?: string }) {
  return (
    <section aria-label={label} className={`${cardClass} space-y-2`}>
      <h3 className="text-sm font-bold text-fg-strong">{label}</h3>
      {rows.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">
          {empty}
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label={label}>
          <li className="hidden grid-cols-4 gap-2 py-1 text-xs font-semibold text-fg-muted sm:grid" aria-hidden="true">
            {head.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </li>
          {rows.map((r) => (
            <li key={r.join('|')} className="grid grid-cols-2 gap-x-3 gap-y-0.5 py-2 sm:grid-cols-4">
              {r.map((cell, i) => (
                <span key={`${String(i)}-${cell}`} className={i === 0 ? 'col-span-2 font-semibold text-fg-strong sm:col-span-1' : 'text-fg'}>
                  <span className="mr-1 text-xs text-fg-muted sm:hidden">{head[i]}:</span>
                  {cell}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
      {note === undefined ? null : <p className="text-xs text-fg-muted">{note}</p>}
    </section>
  );
}
