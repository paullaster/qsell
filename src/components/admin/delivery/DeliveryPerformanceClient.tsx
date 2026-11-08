'use client';

import { use, useState } from 'react';
import { deliveryPerformanceAction } from '@/server/domains/delivery/slot-actions';
import { durationWords, rateTone, rateWords } from '@/lib/delivery-performance';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Loaded = Awaited<ReturnType<typeof deliveryPerformanceAction>>;
type Report = Extract<Loaded, { ok: true }>['data'];

const TONES = { good: 'green', watch: 'amber', poor: 'red', none: 'gray' } as const;
const TONE_WORDS = { good: 'Good', watch: 'Watch', poor: 'Poor', none: 'Nothing to measure' } as const;
const COLUMNS: Record<number, string> = { 5: 'sm:grid-cols-5', 6: 'sm:grid-cols-6', 7: 'sm:grid-cols-7' };

export function DeliveryPerformanceClient({ reportPromise }: { reportPromise: ReturnType<typeof deliveryPerformanceAction> }) {
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
    const r = await attempt(deliveryPerformanceAction({ from, to }));
    setBusy(false);
    if (r.ok) setReport(r.data);
    else setNotice({ kind: 'error', text: r.error });
  };
  const t = report.total;
  const empty = t.delivered === 0;
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Delivery performance" intro="How well delivery is doing over the days you choose. A delivery counts on the day it was delivered. On time means delivered by the end of the window the customer was promised; deliveries promised no window are left out of that rate." />
      <Message notice={notice} />
      <form
        aria-label="Days"
        className={`${cardClass} grid grid-cols-1 items-end gap-3 sm:grid-cols-3`}
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <Field id="perf-from" label="From day">
          <input id="perf-from" type="date" className={fieldClass} value={from} onChange={(e) => setFrom(e.target.value)} required />
        </Field>
        <Field id="perf-to" label="To day">
          <input id="perf-to" type="date" className={fieldClass} value={to} onChange={(e) => setTo(e.target.value)} required />
        </Field>
        <button type="submit" className={primaryClass} disabled={busy}>
          {busy ? 'Working…' : 'Show these days'}
        </button>
      </form>

      <section aria-label="Overall" className={`${cardClass} space-y-3`}>
        <h3 className="text-sm font-bold text-fg-strong">
          {report.period.from} to {report.period.to}
        </h3>
        {empty ? (
          <p role="status" className="text-sm text-fg-muted">
            Nothing was delivered in these days.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Delivered" value={String(t.delivered)} />
            <Stat label="Delivered on time" value={rateWords(t.onTimePercent)} rate={t.onTimePercent} hint={`${String(t.onTime)} of ${String(t.promised)} promised a window`} />
            <Stat label="Delivered at the first try" value={rateWords(t.firstTryPercent, '-')} rate={t.firstTryPercent} hint="No failed attempt before" />
            <Stat label="Going out to delivered" value={durationWords(t.averageTransitMinutes)} hint="On average" />
            <Stat label="Late ones were late by" value={durationWords(t.averageLateMinutes)} hint="On average, of those delivered late" />
            <Stat label="Released to delivered" value={durationWords(t.averageTotalMinutes)} hint="On average, from the warehouse getting it" />
          </dl>
        )}
      </section>

      <Table
        label="By rider"
        empty="No rider delivered anything in these days."
        head={['Rider', 'Delivered', 'On time', 'First try', 'Going out to delivered']}
        rows={report.byRider.map((r) => [r.name, String(r.delivered), rateWords(r.onTimePercent), rateWords(r.firstTryPercent, '-'), durationWords(r.averageTransitMinutes)])}
        note="A delivery counts for the rider who handed it over."
      />
      <Table
        label="By courier"
        empty="No parcel was sent with a courier in these days."
        head={['Courier', 'Sent', 'Delivered so far', 'On time', 'Took', 'Did not get through', 'Not booked or cancelled']}
        rows={report.byCourier.map((r) => [r.courier, String(r.sent), String(r.delivered), rateWords(r.onTimePercent), durationWords(r.averageTransitMinutes), String(r.failedAttempts), String(r.problems)])}
        note="Parcels sent in these days, and what has become of them so far."
      />
      <Table
        label="Delivery times"
        empty="No delivery times are set up."
        head={['Time', 'Branch', 'Places offered', 'Booked', 'Full days', 'Used']}
        rows={report.bySlot.map((s) => [`${s.name}${s.active ? '' : ' (stopped)'} · ${s.times}`, s.branch, String(s.offered), String(s.booked), String(s.fullDays), s.fillPercent === null ? '-' : `${String(s.fillPercent)}%`])}
        note={`Places offered are the capacity of a time for each day in these days it runs and is not closed. ${String(report.chosen)} ${report.chosen === 1 ? 'time was' : 'times were'} chosen by customers at checkout; ${String(report.notKept)} had gone by the time the delivery was made.`}
      />
    </div>
  );
}

function Stat({ label, value, hint, rate }: { label: string; value: string; hint?: string; rate?: number | null }) {
  return (
    <div className="space-y-0.5 rounded-lg border border-line bg-surface p-3">
      <dt className="text-xs font-semibold text-fg-muted">{label}</dt>
      <dd className="text-xl font-bold text-fg-strong">{value}</dd>
      {hint === undefined ? null : <dd className="text-xs text-fg-muted">{hint}</dd>}
      {rate === undefined ? null : <Chip tone={TONES[rateTone(rate)]}>{TONE_WORDS[rateTone(rate)]}</Chip>}
    </div>
  );
}

function Table({ label, head, rows, empty, note }: { label: string; head: string[]; rows: string[][]; empty: string; note?: string }) {
  const cols = COLUMNS[head.length] ?? 'sm:grid-cols-5';
  return (
    <section aria-label={label} className={`${cardClass} space-y-2`}>
      <h3 className="text-sm font-bold text-fg-strong">{label}</h3>
      {rows.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">
          {empty}
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label={label}>
          <li className={`hidden gap-2 py-1 text-xs font-semibold text-fg-muted sm:grid ${cols}`} aria-hidden="true">
            {head.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </li>
          {rows.map((r) => (
            <li key={r.join('|')} className={`grid grid-cols-2 gap-x-3 gap-y-0.5 py-2 ${cols}`}>
              {r.map((cell, i) => (
                <span key={`${String(i)}-${cell}`} className={i === 0 ? 'col-span-2 min-w-0 break-words font-semibold text-fg-strong sm:col-span-1' : 'text-fg'}>
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
