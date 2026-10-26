'use client';

import Link from 'next/link';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { type advancesOutstandingAction, ageingAction, lastPayablesRevaluationAction, revalueForeignPayablesAction, runPayablesCheckAction, type payablesCheckAction } from '@/server/domains/vendors/payment-actions';
import { AGE_BUCKETS, fromCents } from '@/lib/vendor-payment';
import { Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, type Notice } from '@/components/ui/screen-kit';

const GROUP_HEAD = { vendor: 'Vendor', category: 'Category', posting_group: 'Posting group' } as const;

type Report = Extract<Awaited<ReturnType<typeof ageingAction>>, { ok: true }>['data'];

export function PayablesClient({ initialPromise, checkPromise, revaluationPromise, advancesPromise }: { advancesPromise: ReturnType<typeof advancesOutstandingAction>; initialPromise: ReturnType<typeof ageingAction>; checkPromise: ReturnType<typeof payablesCheckAction>; revaluationPromise: ReturnType<typeof lastPayablesRevaluationAction> }) {
  const res = use(initialPromise);
  const check = use(checkPromise);
  const reval = use(revaluationPromise);
  const advances = use(advancesPromise);
  return res.ok ? <View initial={res.data} lastCheck={check.ok ? check.data : null} revaluation={reval.ok ? reval.data : null} advances={advances.ok ? advances.data : null} /> : <LoadFailed error={res.error} />;
}

type Check = NonNullable<Extract<Awaited<ReturnType<typeof payablesCheckAction>>, { ok: true }>['data']>;

type Revaluation = Extract<Awaited<ReturnType<typeof lastPayablesRevaluationAction>>, { ok: true }>['data'];

type Advances = Extract<Awaited<ReturnType<typeof advancesOutstandingAction>>, { ok: true }>['data'];

function View({ initial, lastCheck, revaluation, advances }: { initial: Report; lastCheck: Check | null; revaluation: Revaluation | null; advances: Advances | null }) {
  const uid = useId();
  const [report, setReport] = useState(initial);
  const [asOf, setAsOf] = useState(initial.asOf);
  const [basis, setBasis] = useState<Choice | null>({ id: 'due', label: 'By due date' });
  const [groupBy, setGroupBy] = useState<Choice | null>({ id: 'vendor', label: 'Each vendor' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const reload = async (date: string, b: Choice | null = basis, g: Choice | null = groupBy) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(ageingAction(date, b?.id, g?.id));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setReport(res.data);
  };
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="What we owe" intro="Booked invoices that are still unpaid, by how late they are. Payments and advances not yet set against an invoice are shown apart." actions={<Link href="/admin/vendors/payments" className={buttonClass}>Payments</Link>} />
      <Message notice={notice} />
      <BooksCheck first={lastCheck} />
      {revaluation === null ? null : <ForeignBalances first={revaluation} />}
      <div className={`${cardClass} grid gap-3 md:grid-cols-3`}>
        <Field id={`${uid}-d`} label="As of"><input id={`${uid}-d`} type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); if (e.target.value !== '') void reload(e.target.value); }} className={fieldClass} /></Field>
        <ChoicePicker label="Age counted" source="ageing-bases" choice={basis} onChoice={(c) => { setBasis(c); if (asOf !== '') void reload(asOf, c, groupBy); }} placeholder="By due date" />
        <ChoicePicker label="One line for" source="ageing-groups" choice={groupBy} onChoice={(c) => { setGroupBy(c); if (asOf !== '') void reload(asOf, basis, c); }} placeholder="Each vendor" />
      </div>
      <p className="text-sm text-fg" aria-live="polite">Owed on invoices: <span className="font-semibold">{fromCents(report.owedCents)}</span> · Payments and advances not yet set against an invoice: <span className="font-semibold">{fromCents(-report.unappliedCents)}</span>{busy ? ' · Loading…' : ''}</p>
      {report.lines.length === 0 ? <p className="text-sm text-fg-muted">Nothing is owed.</p> : (
        <>
          <ul className="space-y-2 md:hidden" aria-label="Vendors we owe">
            {report.lines.map((l) => (
              <li key={`${l.vendorId}-${l.currency}`} className={cardClass}>
                {report.groupBy === 'vendor' ? <Link href={`/admin/vendors/payables/${l.vendorId}`} className="block text-sm font-bold text-fg-strong underline">{l.name}</Link> : <p className="text-sm font-bold text-fg-strong">{l.name}</p>}
                <p className="text-xs text-fg-muted">Owed {fromCents(l.owedCents)} {l.currency}{l.unappliedCents === 0 ? '' : ` · unapplied ${fromCents(-l.unappliedCents)}`}</p>
                <ul className="mt-1 text-xs text-fg">{AGE_BUCKETS.filter((b) => l.buckets[b.key] !== 0).map((b) => <li key={b.key}>{b.label}: {fromCents(l.buckets[b.key])}</li>)}</ul>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <table className="w-full text-sm" aria-label="Payables ageing">
              <thead><tr className="text-left text-xs text-fg-muted"><th className="py-2 pr-3">{GROUP_HEAD[report.groupBy]}</th>{AGE_BUCKETS.map((b) => <th key={b.key} className="py-2 pr-3 text-right">{b.label}</th>)}<th className="py-2 pr-3 text-right">Owed</th><th className="py-2 text-right">Unapplied</th></tr></thead>
              <tbody className="divide-y divide-line">
                {report.lines.map((l) => (
                  <tr key={`${l.vendorId}-${l.currency}`}>
                    <td className="py-2 pr-3">{report.groupBy === 'vendor' ? <Link href={`/admin/vendors/payables/${l.vendorId}`} className="font-semibold underline">{l.name}</Link> : <span className="font-semibold">{l.name}</span>}</td>
                    {AGE_BUCKETS.map((b) => <td key={b.key} className="py-2 pr-3 text-right tabular-nums">{fromCents(l.buckets[b.key])}</td>)}
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{fromCents(l.owedCents)}</td>
                    <td className="py-2 text-right tabular-nums">{fromCents(-l.unappliedCents)}</td>
                  </tr>
                ))}
                <tr className="font-semibold"><td className="py-2 pr-3">Total</td>{AGE_BUCKETS.map((b) => <td key={b.key} className="py-2 pr-3 text-right tabular-nums">{fromCents(report.totals[b.key])}</td>)}<td className="py-2 pr-3 text-right tabular-nums">{fromCents(report.owedCents)}</td><td className="py-2 text-right tabular-nums">{fromCents(-report.unappliedCents)}</td></tr>
              </tbody>
            </table>
          </div>
        </>
      )}
      {advances === null ? null : <AdvancesOutstanding data={advances} />}
    </div>
  );
}

/** Advance payments not yet used up, oldest first. */
function AdvancesOutstanding({ data }: { data: Advances }) {
  return (
    <section className={`${cardClass} space-y-2`} aria-label="Advance payments outstanding">
      <h2 className="text-sm font-bold text-fg-strong">Advance payments outstanding</h2>
      <p className="text-xs text-fg-muted">Money paid (or approved to be paid) to vendors before an invoice, not yet set against one. Paid and not yet used: <span className="font-semibold">{fromCents(data.paidNotAppliedCents)}</span> · Approved and waiting to be paid: <span className="font-semibold">{fromCents(data.approvedNotPaidCents)}</span></p>
      {data.lines.length === 0 ? <p className="text-sm text-fg-muted">No advance payment is waiting for an invoice.</p> : (
        <ul className="divide-y divide-line text-sm" aria-label="Advances">
          {data.lines.map((a) => (
            <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span><Link href={`/admin/vendors/payables/${a.vendorId}`} className="font-semibold underline">{a.vendor}</Link> <span className="text-xs text-fg-muted">order {a.poNumber ?? 'without a number'}</span></span>
              <span className="tabular-nums">{fromCents(a.amountCents)} {a.currency} <span className="text-xs text-fg-muted">{a.status === 'paid' ? 'paid' : 'approved'}{a.since === null ? '' : ` ${String(a.days)} days ago`}</span></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The vendor ledger against the payables and prepayments accounts: the last check, and a button to check now. */
function BooksCheck({ first }: { first: Check | null }) {
  const [check, setCheck] = useState<Check | null>(first);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const run = async () => {
    setBusy(true);
    setProblem('');
    const res = await attempt(runPayablesCheckAction());
    setBusy(false);
    if (!res.ok) {
      setProblem(res.error);
      return;
    }
    setCheck(res.data);
  };
  return (
    <section className={`${cardClass} space-y-2`} aria-label="Check against the books">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-fg-strong">Check against the books</h2>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      {problem === '' ? null : <p role="alert" className="text-sm text-red-600">{problem}</p>}
      {check === null ? <p className="text-sm text-fg-muted">It has not been checked yet. It is checked every night.</p> : (
        <>
          <p className="text-sm text-fg" role="status">{check.ok ? 'The vendor ledger agrees with the books.' : `${String(check.differences)} ${check.differences === 1 ? 'difference' : 'differences'} found. Each one is a defect to look into.`} <span className="text-xs text-fg-muted">Checked {new Date(check.ranAt).toLocaleString()}{check.ranBy === 'system' ? ' (nightly)' : ''}.</span></p>
          {check.rows.length === 0 ? null : (
            <ul className="divide-y divide-line text-sm" aria-label="Accounts checked">
              {check.rows.map((r) => (
                <li key={`${r.accountId}-${r.purpose}`} className="flex flex-wrap justify-between gap-2 py-1 text-fg">
                  <span>{r.accountNo} {r.accountName} <span className="text-xs text-fg-muted">({r.purpose === 'payables' ? 'what we owe' : 'advances paid'})</span></span>
                  <span className="tabular-nums">Vendor ledger {fromCents(r.ledgerCents)} · books {fromCents(r.glCents)}{r.diffCents === 0 ? '' : ` · difference ${fromCents(r.diffCents)}`}</span>
                </li>
              ))}
            </ul>
          )}
          {check.drift.length === 0 ? null : <ul className="text-xs text-red-700" aria-label="Entries out of step">{check.drift.map((d) => <li key={d.id}>{d.documentNo}: open {d.remaining}, its entries add up to {d.detailed}</li>)}</ul>}
        </>
      )}
    </section>
  );
}

function ForeignBalances({ first }: { first: Revaluation }) {
  const router = useRouter();
  const [last, setLast] = useState(first.last);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const run = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(revalueForeignPayablesAction());
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: `Revalued: ${res.data.netCents >= 0 ? 'loss' : 'gain'} of ${(Math.abs(res.data.netCents) / 100).toFixed(2)}. It is undone tomorrow, so the real difference is booked when each invoice is paid.` });
    const again = await attempt(lastPayablesRevaluationAction());
    if (again.ok) setLast(again.data.last);
    router.refresh();
  };
  return (
    <section className={`${cardClass} space-y-2`} aria-label="What is owed in other currencies">
      <h2 className="text-sm font-bold text-fg-strong">What is owed in other currencies</h2>
      <p className="text-xs text-fg-muted">Invoices in a foreign currency are carried at the rate of the day they were booked. Revaluing values them at today’s rate for the books; the next day it is undone.</p>
      <Message notice={notice} />
      {last === null ? <p className="text-sm text-fg-muted">Not revalued yet.</p> : <p className="text-sm text-fg">Last revalued on {last.asOf}: {last.netCents >= 0 ? 'loss' : 'gain'} of {(Math.abs(last.netCents) / 100).toFixed(2)}{last.reversed ? ' (undone)' : ' (standing)'}.</p>}
      {first.can ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void run()}>Revalue at today’s rate</button> : null}
    </section>
  );
}
