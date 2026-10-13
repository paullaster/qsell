'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import {
  candidateEntriesAction,
  chargeFromStatementLineAction,
  ignoreStatementLineAction,
  matchStatementLineAction,
  receiptFromStatementLineAction,
  restoreStatementLineAction,
  runAutoMatchAction,
  searchCustomersForStatementAction,
  statementWorkbenchAction,
  unmatchStatementLineAction,
} from '@/server/domains/finance/bank-statement-actions';
import { ReconcilePanel } from './ReconcilePanel';
import { StatementImportPanel } from './StatementImportPanel';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

export type WorkbenchView = Extract<Awaited<ReturnType<typeof statementWorkbenchAction>>, { ok: true }>['data'];
type Line = WorkbenchView['lines'][number];
type Filter = 'open' | 'matched' | 'ignored';
type Panel = { id: number; kind: 'find' | 'customer' | 'ignore' | 'unmatch' } | null;
type Entry = { id: number; date: string; type: string; no: string; description: string; amount: string };

const STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  unmatched: { label: 'Not matched', tone: 'amber' },
  proposed: { label: 'Suggested', tone: 'sky' },
  matched: { label: 'Matched', tone: 'green' },
  ignored: { label: 'Set aside', tone: 'gray' },
};
const TYPE: Record<string, string> = { customer_receipt: 'Receipt', customer_receipt_reversal: 'Receipt reversed', refund: 'Refund', bank_charge: 'Bank charge', cheque_clearing: 'Cheque cleared', cash_sale: 'Cash sale', payment: 'Payment' };
const cents = (v: string) => Math.round(Number(v) * 100);

export function ReasonFields({ id, reasons, value, onChange }: { id: string; reasons: WorkbenchView['reasons']; value: { code: string; text: string }; onChange: (v: { code: string; text: string }) => void }) {
  const chosen = reasons.find((r) => r.code === value.code);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field id={`${id}-r`} label="Reason" hint="Kept with your name, the time and where you did this from.">
        <select id={`${id}-r`} value={value.code} onChange={(e) => onChange({ ...value, code: e.target.value })} className={fieldClass} required>
          <option value="">Choose a reason…</option>
          {reasons.map((r) => <option key={r.code} value={r.code}>{r.description}</option>)}
        </select>
      </Field>
      <Field id={`${id}-t`} label={chosen?.requiresComment ? 'Explain (required)' : 'Comment (optional)'}>
        <input id={`${id}-t`} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} className={fieldClass} required={chosen?.requiresComment ?? false} maxLength={300} autoComplete="off" />
      </Field>
    </div>
  );
}

export function StatementWorkbenchClient({ view: initial }: { view: WorkbenchView }) {
  const uid = useId();
  const [view, setView] = useState(initial);
  const [filter, setFilter] = useState<Filter>('open');
  const [panel, setPanel] = useState<Panel>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reason, setReason] = useState({ code: '', text: '' });
  const [candidates, setCandidates] = useState<Entry[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: string; name: string; number: string; phone: string | null }[]>([]);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [methodId, setMethodId] = useState(initial.methods[0]?.id ?? '');
  const [allocate, setAllocate] = useState<'oldest_first' | 'none'>('oldest_first');
  const [chargeGl, setChargeGl] = useState('');
  const acc = view.account;

  const reload = async (f: Filter = filter) => {
    const res = await attempt(statementWorkbenchAction(acc.id, { status: f }));
    if (res.ok) setView(res.data);
    else setNotice({ kind: 'error', text: res.error });
  };
  const close = () => { setPanel(null); setReason({ code: '', text: '' }); setCandidates(null); setPicked([]); setCustomer(null); setFound([]); setQ(''); };
  const act = async (okText: string, call: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call());
    if (!res.ok) { setBusy(false); return setNotice({ kind: 'error', text: res.error }); }
    close();
    await reload();
    setBusy(false);
    setNotice({ kind: 'ok', text: okText });
  };
  const show = async (f: Filter) => { setFilter(f); close(); await reload(f); };
  const more = async () => {
    if (!view.nextAfter) return;
    const res = await attempt(statementWorkbenchAction(acc.id, { status: filter, before: view.nextAfter }));
    if (res.ok) setView({ ...res.data, lines: [...view.lines, ...res.data.lines] });
  };

  const openFind = async (l: Line) => {
    setPanel({ id: l.id, kind: 'find' });
    setPicked([]);
    const res = await attempt(candidateEntriesAction(acc.id, l.amount, l.date));
    if (res.ok) setCandidates(res.data); else setNotice({ kind: 'error', text: res.error });
  };
  const search = async () => {
    const res = await attempt(searchCustomersForStatementAction(q));
    if (res.ok) setFound(res.data as typeof found); else setNotice({ kind: 'error', text: res.error });
  };
  const pickedTotal = (candidates ?? []).filter((c) => picked.includes(c.id)).reduce((n, c) => n + cents(c.amount), 0);

  const lineCard = (l: Line) => {
    const out = Number(l.amount) < 0;
    const p = panel?.id === l.id ? panel : null;
    const locked = l.reconciled;
    return (
      <li key={l.id} className={`${cardClass} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-fg-muted">{l.date}{l.reference ? ` · ${l.reference}` : ''}</p>
            <p className="break-words text-sm font-semibold text-fg-strong">{l.description || '(no description)'}</p>
            {l.counterparty ? <p className="text-xs text-fg-muted">{l.counterparty}</p> : null}
          </div>
          <div className="text-right">
            <p className={`text-base font-bold tabular-nums ${out ? 'text-red-700' : 'text-green-700'}`}>{money(l.amount)}</p>
            <span className="flex flex-wrap justify-end gap-1"><Chip tone={STATUS[l.status]?.tone ?? 'gray'}>{STATUS[l.status]?.label ?? l.status}</Chip>{locked ? <Chip tone="gray">Reconciled</Chip> : null}</span>
          </div>
        </div>

        {l.matches.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {l.matches.map((m) => <li key={m.entryId}>Matched to <b>{TYPE[m.type] ?? m.type} {m.no}</b> · {money(m.amount)} <span className="text-fg-muted">({m.rule.replace(/[:_]/g, ' ')})</span></li>)}
          </ul>
        ) : null}
        {l.status === 'ignored' && l.ignoreReason ? <p className="text-xs text-fg-muted">Set aside: {l.ignoreReason}</p> : null}

        {l.status === 'proposed' && l.proposals.length > 0 ? (
          <div className="space-y-1" role="group" aria-label="Suggested matches">
            <p className="text-xs font-semibold text-fg-muted">Looks like:</p>
            {l.proposals.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
                <span><b>{TYPE[e.type] ?? e.type} {e.no}</b> · {e.date} · {money(e.amount)}{e.description ? ` · ${e.description}` : ''}</span>
                {view.can.match ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act('Matched.', () => matchStatementLineAction(acc.id, l.id, [e.id]))}>Yes, match it</button> : null}
              </div>
            ))}
          </div>
        ) : null}

        {!locked ? (
          <div className="flex flex-wrap gap-2">
            {(l.status === 'unmatched' || l.status === 'proposed') && view.can.match ? <button type="button" className={buttonClass} disabled={busy} aria-expanded={p?.kind === 'find'} onClick={() => void openFind(l)}>Find in our records</button> : null}
            {(l.status === 'unmatched' || l.status === 'proposed') && !out && view.can.createReceipt && view.methods.length > 0 ? <button type="button" className={buttonClass} disabled={busy} aria-expanded={p?.kind === 'customer'} onClick={() => { close(); setPanel({ id: l.id, kind: 'customer' }); }}>It is a customer&apos;s payment</button> : null}
            {(l.status === 'unmatched' || l.status === 'proposed') && out && view.can.recordCharge ? (
              acc.hasFeeAccount
                ? (
                  <span className="flex flex-wrap items-center gap-2">
                    {view.chargeGls.length > 1 ? (
                      <select aria-label="G/L account the charge came out of" value={chargeGl} onChange={(e) => setChargeGl(e.target.value)} className={`${fieldClass} w-auto`}>
                        <option value="">Which G/L account?</option>
                        {view.chargeGls.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                      </select>
                    ) : null}
                    <button type="button" className={buttonClass} disabled={busy || (view.chargeGls.length > 1 && !chargeGl)} onClick={() => void act('Charge recorded and matched.', () => chargeFromStatementLineAction(acc.id, l.id, view.chargeGls.length > 1 ? chargeGl : undefined))}>Record as a bank charge</button>
                  </span>
                )
                : <Chip tone="amber">No fee account set (Bank accounts)</Chip>
            ) : null}
            {(l.status === 'unmatched' || l.status === 'proposed') && view.can.ignore ? <button type="button" className={buttonClass} disabled={busy} aria-expanded={p?.kind === 'ignore'} onClick={() => { close(); setPanel({ id: l.id, kind: 'ignore' }); }}>Set aside</button> : null}
            {l.status === 'matched' && view.can.unmatch ? <button type="button" className={dangerClass} disabled={busy} aria-expanded={p?.kind === 'unmatch'} onClick={() => { close(); setPanel({ id: l.id, kind: 'unmatch' }); }}>Undo match</button> : null}
            {l.status === 'ignored' && view.can.ignore ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act('Brought back.', () => restoreStatementLineAction(acc.id, l.id))}>Bring back</button> : null}
          </div>
        ) : null}

        {p?.kind === 'find' ? (
          <div className="space-y-2 rounded-lg border border-line p-3" role="group" aria-label="Choose what this line matches">
            <p className="text-xs text-fg-muted">Tick what the bank paid in or out with this line. They must add up to {money(l.amount)} exactly.</p>
            {candidates === null ? <p className="text-xs">Looking…</p> : candidates.length === 0 ? <p className="text-xs text-fg-muted">Nothing in our records is waiting for this account.</p> : (
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {candidates.map((c) => (
                  <li key={c.id}>
                    <label className="flex min-h-10 items-center gap-2 text-xs">
                      <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                      <span><b>{TYPE[c.type] ?? c.type} {c.no}</b> · {c.date} · {money(c.amount)}{c.description ? ` · ${c.description}` : ''}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs" aria-live="polite">Chosen: <b>{money((pickedTotal / 100).toFixed(2))}</b> of {money(l.amount)}</p>
            <div className="flex gap-2">
              <button type="button" className={primaryClass} disabled={busy || picked.length === 0 || pickedTotal !== cents(l.amount)} onClick={() => void act('Matched.', () => matchStatementLineAction(acc.id, l.id, picked))}>Match</button>
              <button type="button" className={buttonClass} onClick={close}>Close</button>
            </div>
          </div>
        ) : null}

        {p?.kind === 'customer' ? (
          <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); if (customer) void act('Receipt created, posted and matched.', () => receiptFromStatementLineAction(acc.id, l.id, { customerId: customer.id, paymentMethodId: methodId, allocate })); }}>
            <p className="text-xs text-fg-muted">This creates a posted receipt of {money(l.amount)} dated {l.date} and closes the line against it.</p>
            {customer ? <p className="text-sm">Customer: <b>{customer.name}</b> <button type="button" className="text-xs font-semibold text-indigo-600 underline" onClick={() => setCustomer(null)}>change</button></p> : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-48 flex-1"><Field id={`${uid}-cq${l.id}`} label="Find the customer"><input id={`${uid}-cq${l.id}`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} className={fieldClass} placeholder="Name, number or phone" autoComplete="off" /></Field></div>
                  <button type="button" className={buttonClass} onClick={() => void search()}>Search</button>
                </div>
                <ul className="space-y-1">{found.map((c) => <li key={c.id}><button type="button" className={`${buttonClass} w-full justify-start text-left`} onClick={() => setCustomer({ id: c.id, name: c.name })}>{c.name} · {c.number}{c.phone ? ` · ${c.phone}` : ''}</button></li>)}</ul>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${uid}-m${l.id}`} label="Paid by"><select id={`${uid}-m${l.id}`} value={methodId} onChange={(e) => setMethodId(e.target.value)} className={fieldClass} required>{view.methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
              <Field id={`${uid}-a${l.id}`} label="Apply to invoices"><select id={`${uid}-a${l.id}`} value={allocate} onChange={(e) => setAllocate(e.target.value as 'none')} className={fieldClass}><option value="oldest_first">Oldest first</option><option value="none">Leave unapplied</option></select></Field>
            </div>
            <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy || !customer}>Create receipt</button><button type="button" className={buttonClass} onClick={close}>Close</button></div>
          </form>
        ) : null}

        {p?.kind === 'ignore' || p?.kind === 'unmatch' ? (
          <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); const r = { code: reason.code, text: reason.text.trim() || undefined }; void (p.kind === 'ignore' ? act('Set aside.', () => ignoreStatementLineAction(acc.id, l.id, r)) : act('Match undone.', () => unmatchStatementLineAction(acc.id, l.id, r))); }}>
            <p className="text-xs text-fg-muted">{p.kind === 'ignore' ? 'Use this only when the bank moved money that we do not and will not record. It still counts in the reconciliation.' : 'The line goes back to the list; the entries become free to match again.'}</p>
            <ReasonFields id={`${uid}-x${l.id}`} reasons={view.reasons} value={reason} onChange={setReason} />
            <div className="flex gap-2"><button type="submit" className={p.kind === 'ignore' ? primaryClass : dangerClass} disabled={busy}>{p.kind === 'ignore' ? 'Set aside' : 'Undo match'}</button><button type="button" className={buttonClass} onClick={close}>Close</button></div>
          </form>
        ) : null}
      </li>
    );
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`${acc.code} — ${acc.name}`}
        intro={<span>In our books {acc.currency} <b>{money(view.bookBalance)}</b> · {view.counts.unmatched + view.counts.proposed} line{view.counts.unmatched + view.counts.proposed === 1 ? '' : 's'} to deal with · {view.outstandingCount} of our entr{view.outstandingCount === 1 ? 'y' : 'ies'} not on a statement yet</span>}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/finance/bank-statements" className={buttonClass}>All accounts</Link>
            {view.can.match ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act('Matching done.', async () => { const r = await attempt(runAutoMatchAction(acc.id)); if (r.ok) setNotice({ kind: 'ok', text: `${r.data.autoMatched} matched by themselves, ${r.data.proposed} suggested.` }); return r; })}>Match automatically</button> : null}
            {view.can.import ? <button type="button" className={primaryClass} aria-expanded={importing} onClick={() => setImporting(!importing)}>Import a statement</button> : null}
          </div>
        }
      />
      <Message notice={notice} />
      {importing ? <StatementImportPanel bankAccountId={acc.id} onClose={() => { setImporting(false); void reload(); }} /> : null}

      <div role="group" aria-label="Show lines" className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} aria-pressed={filter === 'open'} onClick={() => void show('open')}>To deal with ({view.counts.unmatched + view.counts.proposed})</button>
        <button type="button" className={buttonClass} aria-pressed={filter === 'matched'} onClick={() => void show('matched')}>Matched ({view.counts.matched})</button>
        <button type="button" className={buttonClass} aria-pressed={filter === 'ignored'} onClick={() => void show('ignored')}>Set aside ({view.counts.ignored})</button>
      </div>
      {view.lines.length === 0 ? (
        <p className="text-sm text-fg-muted">{filter === 'open' ? (view.imports.length === 0 ? 'No statement has been imported for this account yet.' : 'Every imported line has been dealt with.') : 'Nothing here.'}</p>
      ) : (
        <ul className="space-y-3">{view.lines.map(lineCard)}</ul>
      )}
      {view.nextAfter ? <button type="button" className={buttonClass} onClick={() => void more()}>Show more</button> : null}

      <ReconcilePanel key={`${view.counts.unmatched}-${view.counts.proposed}-${view.counts.matched}-${view.counts.ignored}-${view.counts.unreconciled}-${view.reconciliations.length}-${view.reconciliations.filter((r) => r.status === 'posted').length}`} view={view} onDone={async (text) => { setNotice({ kind: 'ok', text }); await reload(); }} />

      <section className={`${cardClass} space-y-2`} aria-label="Our entries not yet on a statement">
        <h2 className="text-sm font-bold text-fg-strong">Ours, not on a statement yet ({view.outstandingCount}, net {money(view.outstandingNet)})</h2>
        <p className="text-xs text-fg-muted">Recorded in our books for this account but not seen on any imported line: payments in transit, or money the bank has not yet shown.</p>
        {view.outstanding.length === 0 ? <p className="text-sm text-fg-muted">None.</p> : (
          <ul className="divide-y divide-line text-xs">
            {view.outstanding.map((e) => <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2"><span><b>{TYPE[e.type] ?? e.type} {e.no}</b> · {e.date}{e.description ? ` · ${e.description}` : ''}</span><b className={Number(e.amount) < 0 ? 'text-red-700' : 'text-green-700'}>{money(e.amount)}</b></li>)}
          </ul>
        )}
      </section>

      {view.imports.length > 0 ? (
        <section className={`${cardClass} space-y-2`} aria-label="Imported files">
          <h2 className="text-sm font-bold text-fg-strong">Imported files</h2>
          <ul className="text-xs">{view.imports.map((i) => <li key={i.id} className="py-1">{i.fileName} · {i.lines} lines · {i.from} to {i.to} · in {money(i.in)}, out {money(i.out)} · {new Date(i.at).toLocaleDateString()}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}
