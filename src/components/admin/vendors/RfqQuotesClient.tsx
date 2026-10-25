'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { awardRfqAction, decideQuoteAction, type rfqQuotesAction } from '@/server/domains/vendors/rfq-actions';
import { makeOrderFromAwardAction, toMakeAction } from '@/server/domains/vendors/po-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof rfqQuotesAction>>, { ok: true }>['data'];
type Open = Extract<View, { sealed: false }>;
type Result = { ok: true } | { ok: false; error: string };

const noteLabel = (kind: 'reject' | 'revise', needsComment: boolean): string => {
  if (kind === 'revise') return 'What must change';
  return needsComment ? 'Explain (required)' : 'Comment (optional)';
};

const money = (cents: number): string => (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DECISION: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  pending: { label: 'Not decided', tone: 'gray' },
  accepted: { label: 'Accepted for award', tone: 'green' },
  rejected: { label: 'Refused', tone: 'red' },
  revision_requested: { label: 'Revision asked for', tone: 'amber' },
};

export function RfqQuotesClient({ rfqId, viewPromise }: { rfqId: string; viewPromise: ReturnType<typeof rfqQuotesAction> }) {
  const res = use(viewPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  return res.data.sealed ? <Sealed rfqId={rfqId} view={res.data} /> : <Quotes rfqId={rfqId} view={res.data} />;
}

/** One draft purchase order per awarded vendor, made from the award; nothing is typed again. */
function MakeOrders({ rfqId }: { rfqId: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<{ vendorId: string; name: string; lines: number; orderId: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const load = async () => {
    const res = await attempt(toMakeAction(rfqId));
    if (res.ok) setRows(res.data);
    else setNotice({ kind: 'error', text: res.error });
  };
  const make = async (vendorId: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(makeOrderFromAwardAction(rfqId, vendorId));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.push(`/admin/vendors/orders/${res.data.id}`);
  };
  return (
    <div className="mt-3 space-y-2" role="group" aria-label="Purchase orders from this award">
      <Message notice={notice} />
      {rows === null ? <button type="button" className={buttonClass} onClick={() => void load()}>Make the purchase orders…</button> : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r) => (
            <li key={r.vendorId} className="flex flex-wrap items-center justify-between gap-2 py-2"><span>{r.name} · {r.lines} {r.lines === 1 ? 'line' : 'lines'}</span>{r.orderId === null ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void make(r.vendorId)}>{`Make the order for ${r.name}`}</button> : <Link href={`/admin/vendors/orders/${r.orderId}`} className="font-semibold text-indigo-600 hover:underline">Open the order</Link>}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VendorChip({ declined, hasQuote, tone, label }: { declined: boolean; hasQuote: boolean; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray'; label: string }) {
  if (declined) return <Chip tone="gray">Declined to bid</Chip>;
  return hasQuote ? <Chip tone={tone}>{label}</Chip> : <Chip tone="gray">No quote</Chip>;
}

type QuoteLine = NonNullable<Open['vendors'][number]['quote']>['lines'][number];

/** One vendor's answer to one line, or what it did not bid. */
function Cell({ ql, alt, lowest }: { ql: QuoteLine | undefined; alt: QuoteLine[]; lowest: boolean }) {
  return (
    <>
      {ql === undefined ? '—' : null}
      {ql?.noBid === true ? <span className="text-fg-muted">Not bid</span> : null}
      {ql !== undefined && !ql.noBid ? <span><span className="font-semibold">{ql.unitPrice}</span> × {ql.quantity}{lowest ? <span className="ml-1 font-semibold text-green-700">lowest</span> : null}<span className="block text-fg-muted">{ql.leadTimeDays === null ? '' : `${String(ql.leadTimeDays)} days`}{ql.brand === null ? '' : ` · ${ql.brand}`}{ql.taxRate === '0.00' ? '' : ` · tax ${ql.taxRate}%`}</span></span> : null}
      {alt.map((a) => <span key={a.id} className="block text-fg-muted">Alternative: {a.unitPrice} × {a.quantity}{a.note === null ? '' : ` (${a.note})`}</span>)}
    </>
  );
}

function Sealed({ rfqId, view }: { rfqId: string; view: Extract<View, { sealed: true }> }) {
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Quotes" actions={<Link href={`/admin/vendors/rfqs/${rfqId}`} className={buttonClass}>Back to the request</Link>} />
      <section className={cardClass} aria-label="Sealed quotes">
        <p className="text-sm font-semibold text-fg-strong">The quotes are sealed.</p>
        <p className="mt-1 text-sm text-fg">{view.received} {view.received === 1 ? 'quote has' : 'quotes have'} arrived. Nobody can read them, and the vendors are not named, until the deadline{view.opensAt === null ? '' : ` (${new Date(view.opensAt).toLocaleString()})`} or until the request is closed.</p>
      </section>
    </div>
  );
}

function Quotes({ rfqId, view }: { rfqId: string; view: Open }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [mode, setMode] = useState<{ vendorId: string; kind: 'reject' | 'revise' } | null>(null);
  const [reason, setReason] = useState<Choice | null>(null);
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [pick, setPick] = useState<Record<string, { vendorId: string; quantity: string }[]>>({});
  const [why, setWhy] = useState('');
  const awarded = view.awards.length > 0;
  const needsComment = reason?.meta?.requiresComment === '1';
  const nameOf = (id: string) => view.vendors.find((v) => v.vendorId === id)?.name ?? '';

  const act = async (call: Promise<Result>, done: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: done });
    setMode(null);
    setReason(null);
    setText('');
    setDue('');
    router.refresh();
  };
  const toggle = (lineId: string, vendorId: string, quantity: string) => setPick((p) => {
    const cur = p[lineId] ?? [];
    const has = cur.some((c) => c.vendorId === vendorId);
    return { ...p, [lineId]: has ? cur.filter((c) => c.vendorId !== vendorId) : [...cur, { vendorId, quantity }] };
  });
  const setQty = (lineId: string, vendorId: string, quantity: string) => setPick((p) => ({ ...p, [lineId]: (p[lineId] ?? []).map((c) => (c.vendorId === vendorId ? { ...c, quantity } : c)) }));
  const allocations = Object.entries(pick).flatMap(([rfqLineId, list]) => list.map((c) => ({ rfqLineId, vendorId: c.vendorId, quantity: c.quantity })));

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Quotes and comparison" intro="Prices in the request’s currency. The lowest price on each line is marked, and the lowest complete quote is marked in the totals." actions={<Link href={`/admin/vendors/rfqs/${rfqId}`} className={buttonClass}>Back to the request</Link>} />
      <Message notice={notice} />

      <section className={`${cardClass} overflow-x-auto`} aria-label="Comparison">
        <table className="w-full min-w-[34rem] text-left text-xs">
          <caption className="sr-only">One row for each line, one column for each vendor</caption>
          <thead className="text-fg-muted"><tr><th scope="col" className="py-2 pr-3">Line</th>{view.vendors.filter((v) => v.quote !== null).map((v) => <th key={v.vendorId} scope="col" className="pr-3">{v.name}</th>)}</tr></thead>
          <tbody>
            {view.lines.map((l) => {
              const row = view.sheet.rows.find((r) => r.lineId === l.id);
              return (
                <tr key={l.id} className="border-t border-line align-top">
                  <th scope="row" className="py-2 pr-3 font-medium text-fg-strong">{l.description}<span className="block font-normal text-fg-muted">{l.quantity} {l.unit}</span></th>
                  {view.vendors.filter((v) => v.quote !== null).map((v) => {
                    const ql = v.quote?.lines.find((x) => x.rfqLineId === l.id && !x.isAlternative);
                    const alt = v.quote?.lines.filter((x) => x.rfqLineId === l.id && x.isAlternative) ?? [];
                    const lowest = row?.lowest.includes(v.vendorId) === true;
                    return (
                      <td key={v.vendorId} className={`pr-3 ${lowest ? 'bg-green-500/10' : ''}`}>
                        <Cell ql={ql} alt={alt} lowest={lowest} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-t-2 border-line font-semibold">
              <th scope="row" className="py-2 pr-3">Total with tax</th>
              {view.vendors.filter((v) => v.quote !== null).map((v) => {
                const t = view.sheet.vendors.find((x) => x.vendorId === v.vendorId);
                return <td key={v.vendorId} className={`pr-3 ${view.sheet.lowestComplete.includes(v.vendorId) ? 'bg-green-500/10' : ''}`}>{t === undefined ? '—' : money(t.total)}{t?.complete === true ? '' : <span className="block text-[11px] font-normal text-amber-700">Did not bid on every line</span>}{view.sheet.lowestComplete.includes(v.vendorId) ? <span className="block text-[11px] text-green-700">Lowest complete quote</span> : null}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </section>

      <ul className="space-y-3" aria-label="Vendors">
        {view.vendors.map((v) => {
          const d = DECISION[v.decision] ?? { label: v.decision, tone: 'gray' as const };
          return (
            <li key={v.vendorId} className={`${cardClass} space-y-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-fg-strong">{v.name}{v.number === null ? '' : ` · ${v.number}`}</h3>
                <span className="flex items-center gap-2"><VendorChip declined={v.invitation === 'declined'} hasQuote={v.quote !== null} tone={d.tone} label={d.label} /></span>
              </div>
              {v.invitation === 'declined' ? <p className="text-xs text-fg-muted">Reason: {v.declineReason}</p> : null}
              {v.quote === null ? null : (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                  <div><dt className="text-fg-muted">Version</dt><dd className="font-medium">{v.quote.version}{v.versions.length > 1 ? ` of ${String(v.versions.length)}` : ''}</dd></div>
                  <div><dt className="text-fg-muted">Total</dt><dd className="font-medium">{v.quote.total}</dd></div>
                  <div><dt className="text-fg-muted">Holds until</dt><dd className="font-medium">{v.quote.validUntil ?? '—'}</dd></div>
                  <div><dt className="text-fg-muted">Payment terms</dt><dd className="font-medium">{v.quote.paymentTerms ?? '—'}</dd></div>
                </dl>
              )}
              {v.decisionComment === null ? null : <p className="text-xs text-fg-muted">{v.decision === 'rejected' ? 'Told: ' : 'Asked: '}{v.decisionComment}</p>}
              {v.quote !== null && !awarded && mode?.vendorId === v.vendorId ? (
                  <form className="space-y-2 rounded-lg border border-line p-3" aria-label={mode.kind === 'reject' ? `Refuse the quote from ${v.name}` : `Ask ${v.name} to revise`} onSubmit={(e) => { e.preventDefault(); void act(decideQuoteAction(rfqId, v.vendorId, mode.kind, { reasonCode: reason?.id ?? '', text, due }), mode.kind === 'reject' ? 'The quote is refused and the vendor told.' : 'The vendor was asked to revise its quote.'); }}>
                    {mode.kind === 'reject' ? <ChoicePicker label="Reason" source="rfq-rejection-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" /> : null}
                    <Field id={`${uid}-n`} label={noteLabel(mode.kind, needsComment)} hint={mode.kind === 'reject' ? 'The vendor is told this, and never another vendor’s name or price.' : undefined}><input id={`${uid}-n`} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} required={mode.kind === 'revise' || needsComment} maxLength={1000} autoComplete="off" /></Field>
                    {mode.kind === 'revise' ? <Field id={`${uid}-d`} label="Send the revision by"><input id={`${uid}-d`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={fieldClass} required /></Field> : null}
                    <div className="flex gap-2"><button type="submit" className={mode.kind === 'reject' ? dangerClass : primaryClass} disabled={busy || (mode.kind === 'reject' && reason === null)}>{mode.kind === 'reject' ? 'Refuse the quote' : 'Ask for a revision'}</button><button type="button" className={buttonClass} onClick={() => setMode(null)}>Cancel</button></div>
                  </form>
              ) : null}
              {v.quote !== null && !awarded && mode?.vendorId !== v.vendorId ? (
                  <div className="flex flex-wrap gap-2">
                    {v.decision === 'accepted' ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(decideQuoteAction(rfqId, v.vendorId, 'accept', {}), 'Accepted for award.')}>Accept for award</button>}
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => { setMode({ vendorId: v.vendorId, kind: 'revise' }); setText(''); }}>Ask for a revision…</button>
                    <button type="button" className={dangerClass} disabled={busy} onClick={() => { setMode({ vendorId: v.vendorId, kind: 'reject' }); setText(''); setReason(null); }}>Refuse…</button>
                  </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {awarded ? (
        <section className={cardClass} aria-label="Award">
          <h3 className="text-sm font-bold text-fg-strong">Awarded</h3>
          <ul className="mt-2 divide-y divide-line text-sm">{view.awards.map((a) => <li key={a.id} className="py-2">{a.description}: {a.quantity} to <span className="font-semibold">{a.vendorName}</span> at {a.unitPrice}{a.justification === null ? '' : ` — ${a.justification}`}</li>)}</ul>
          <MakeOrders rfqId={rfqId} />
        </section>
      ) : null}
      {!awarded && view.canAward ? (
        <section className={`${cardClass} space-y-3`} aria-label="Award">
          <h3 className="text-sm font-bold text-fg-strong">Award</h3>
          <p className="text-xs text-fg-muted">Tick the vendor or vendors for each line and the quantity each gets. If you choose someone who is not the lowest price on a line, write why.</p>
          {view.lines.map((l) => (
            <fieldset key={l.id} className="space-y-1 rounded-lg border border-line p-3">
              <legend className="px-1 text-sm font-semibold text-fg-strong">{l.description} ({l.quantity} {l.unit})</legend>
              {view.vendors.filter((v) => v.decision !== 'rejected' && v.quote?.lines.some((x) => x.rfqLineId === l.id && !x.isAlternative && !x.noBid) === true).map((v) => {
                const on = (pick[l.id] ?? []).find((c) => c.vendorId === v.vendorId);
                const ql = v.quote?.lines.find((x) => x.rfqLineId === l.id && !x.isAlternative);
                return (
                  <div key={v.vendorId} className="flex flex-wrap items-center gap-3">
                    <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg"><input type="checkbox" className="h-5 w-5" checked={on !== undefined} onChange={() => toggle(l.id, v.vendorId, ql?.quantity ?? l.quantity)} />{v.name} at {ql?.unitPrice}</label>
                    {on === undefined ? null : <Field id={`${uid}-q-${l.id}-${v.vendorId}`} label={`Quantity for ${v.name}`}><input id={`${uid}-q-${l.id}-${v.vendorId}`} inputMode="decimal" value={on.quantity} onChange={(e) => setQty(l.id, v.vendorId, e.target.value)} className={`${fieldClass} w-28`} /></Field>}
                  </div>
                );
              })}
            </fieldset>
          ))}
          <Field id={`${uid}-j`} label="Why (required when you do not choose the lowest price)"><input id={`${uid}-j`} value={why} onChange={(e) => setWhy(e.target.value)} className={fieldClass} maxLength={1000} autoComplete="off" /></Field>
          <button type="button" className={primaryClass} disabled={busy || allocations.length === 0} onClick={() => void act(awardRfqAction(rfqId, allocations, why).then((r) => (r.ok ? { ok: true as const } : r)), 'Awarded. The vendors were told the result.')}>Award{allocations.length === 0 ? '' : ` (${String(new Set(allocations.map((a) => a.vendorId)).size)} ${new Set(allocations.map((a) => a.vendorId)).size === 1 ? 'vendor' : 'vendors'}: ${[...new Set(allocations.map((a) => nameOf(a.vendorId)))].join(', ')})`}</button>
        </section>
      ) : null}
    </div>
  );
}
