'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { ageingAction } from '@/server/domains/vendors/payment-actions';
import { AGE_BUCKETS, fromCents } from '@/lib/vendor-payment';
import { Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, type Notice } from '@/components/ui/screen-kit';

type Report = Extract<Awaited<ReturnType<typeof ageingAction>>, { ok: true }>['data'];

export function PayablesClient({ initialPromise }: { initialPromise: ReturnType<typeof ageingAction> }) {
  const res = use(initialPromise);
  return res.ok ? <View initial={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ initial }: { initial: Report }) {
  const uid = useId();
  const [report, setReport] = useState(initial);
  const [asOf, setAsOf] = useState(initial.asOf);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const reload = async (date: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(ageingAction(date));
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
      <div className={`${cardClass} max-w-xs`}>
        <Field id={`${uid}-d`} label="As of"><input id={`${uid}-d`} type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); if (e.target.value !== '') void reload(e.target.value); }} className={fieldClass} /></Field>
      </div>
      <p className="text-sm text-fg" aria-live="polite">Owed on invoices: <span className="font-semibold">{fromCents(report.owedCents)}</span> · Payments and advances not yet set against an invoice: <span className="font-semibold">{fromCents(-report.unappliedCents)}</span>{busy ? ' · Loading…' : ''}</p>
      {report.lines.length === 0 ? <p className="text-sm text-fg-muted">Nothing is owed.</p> : (
        <>
          <ul className="space-y-2 md:hidden" aria-label="Vendors we owe">
            {report.lines.map((l) => (
              <li key={`${l.vendorId}-${l.currency}`} className={cardClass}>
                <Link href={`/admin/vendors/payables/${l.vendorId}`} className="block text-sm font-bold text-fg-strong underline">{l.name}</Link>
                <p className="text-xs text-fg-muted">Owed {fromCents(l.owedCents)} {l.currency}{l.unappliedCents === 0 ? '' : ` · unapplied ${fromCents(-l.unappliedCents)}`}</p>
                <ul className="mt-1 text-xs text-fg">{AGE_BUCKETS.filter((b) => l.buckets[b.key] !== 0).map((b) => <li key={b.key}>{b.label}: {fromCents(l.buckets[b.key])}</li>)}</ul>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <table className="w-full text-sm" aria-label="Payables ageing">
              <thead><tr className="text-left text-xs text-fg-muted"><th className="py-2 pr-3">Vendor</th>{AGE_BUCKETS.map((b) => <th key={b.key} className="py-2 pr-3 text-right">{b.label}</th>)}<th className="py-2 pr-3 text-right">Owed</th><th className="py-2 text-right">Unapplied</th></tr></thead>
              <tbody className="divide-y divide-line">
                {report.lines.map((l) => (
                  <tr key={`${l.vendorId}-${l.currency}`}>
                    <td className="py-2 pr-3"><Link href={`/admin/vendors/payables/${l.vendorId}`} className="font-semibold underline">{l.name}</Link></td>
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
    </div>
  );
}
