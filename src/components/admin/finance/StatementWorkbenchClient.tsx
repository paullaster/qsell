'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import {
  bankFeedStatusAction,
  bankMatchRulesAction,
  candidateEntriesAction,
  chargeFromStatementLineAction,
  ignoreStatementLineAction,
  matchStatementLineAction,
  receiptFromStatementLineAction,
  restoreStatementLineAction,
  runAutoMatchAction,
  statementWorkbenchAction,
  unmatchStatementLineAction,
} from '@/server/domains/finance/bank-statement-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { LINE_STATUS, emptyLinesText, entryType, isOutgoing, plural, ruleWords, toDealWith } from '@/lib/bank-statement';
import { statusInfo } from '@/lib/finance-statuses';
import { has } from '@/lib/finance-history';
import type { Choice } from '@/lib/payment-options';
import { ReconcilePanel } from './ReconcilePanel';
import { StatementImportPanel } from './StatementImportPanel';
import { StatementSettingsPanel, type SettingsLoads } from './StatementSettingsPanel';
import { CustomerReceiptPanel, FindEntriesPanel, ReasonPanel, type CandidateEntry } from './StatementLinePanels';
import { Chip, LoadFailed, Message, PageHeader, buttonClass, cardClass, dangerClass, money, primaryClass, type Notice, attempt } from './ui';

export type WorkbenchView = Extract<Awaited<ReturnType<typeof statementWorkbenchAction>>, { ok: true }>['data'];
type Line = WorkbenchView['lines'][number];
type Filter = 'open' | 'matched' | 'ignored';
type Panel = { id: number; kind: 'find' | 'customer' | 'ignore' | 'unmatch' } | null;
type Done = { ok: true; data?: unknown } | { ok: false; error: string };

export function StatementWorkbenchClient({ viewPromise }: { viewPromise: ReturnType<typeof statementWorkbenchAction> }) {
  const res = use(viewPromise);
  return res.ok ? <StatementWorkbench initial={res.data} /> : <LoadFailed error={res.error} />;
}

function StatementWorkbench({ initial }: { initial: WorkbenchView }) {
  const [view, setView] = useState(initial);
  const [filter, setFilter] = useState<Filter>('open');
  const [panel, setPanel] = useState<Panel>(null);
  const [importing, setImporting] = useState(false);
  const [settings, setSettings] = useState<SettingsLoads | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [candidates, setCandidates] = useState<CandidateEntry[] | null>(null);
  const [chargeGl, setChargeGl] = useState<Choice | null>(null);
  const acc = view.account;
  const toDo = toDealWith(view.counts);

  const reload = async (f: Filter = filter) => {
    const res = await attempt(statementWorkbenchAction(acc.id, { status: f }));
    if (res.ok) setView(res.data);
    else setNotice({ kind: 'error', text: res.error });
  };
  const close = () => {
    setPanel(null);
    setCandidates(null);
  };
  const act = async (okText: string, call: () => Promise<Done>) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call());
    if (!res.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    close();
    await reload();
    setBusy(false);
    setNotice({ kind: 'ok', text: okText });
  };
  const show = async (f: Filter) => {
    setFilter(f);
    close();
    await reload(f);
  };
  const more = async () => {
    if (view.nextAfter === null) return;
    const res = await attempt(statementWorkbenchAction(acc.id, { status: filter, before: view.nextAfter }));
    if (res.ok) setView({ ...res.data, lines: [...view.lines, ...res.data.lines] });
  };
  const openFind = async (l: Line) => {
    setPanel({ id: l.id, kind: 'find' });
    const res = await attempt(candidateEntriesAction(acc.id, l.amount, l.date));
    if (res.ok) setCandidates(res.data);
    else setNotice({ kind: 'error', text: res.error });
  };
  const autoMatch = () =>
    act('Matching done.', async () => {
      const r = await attempt(runAutoMatchAction(acc.id));
      if (r.ok) setNotice({ kind: 'ok', text: `${r.data.autoMatched} matched by themselves, ${r.data.proposed} suggested.` });
      return r;
    });

  const needsGlChoice = view.chargeGlCount > 1;
  const emptyText = emptyLinesText(filter, view.imports.length);

  const lineCard = (l: Line) => {
    const out = isOutgoing(l.amount);
    const p = panel?.id === l.id ? panel : null;
    const open = l.status === 'unmatched' || l.status === 'proposed';
    const state = statusInfo(LINE_STATUS, l.status);
    return (
      <li key={l.id} className={`${cardClass} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-fg-muted">{l.date}{has(l.reference) ? ` · ${l.reference}` : ''}</p>
            <p className="break-words text-sm font-semibold text-fg-strong">{has(l.description) ? l.description : '(no description)'}</p>
            {has(l.counterparty) ? <p className="text-xs text-fg-muted">{l.counterparty}</p> : null}
          </div>
          <div className="text-right">
            <p className={`text-base font-bold tabular-nums ${out ? 'text-red-700' : 'text-green-700'}`}>{money(l.amount)}</p>
            <span className="flex flex-wrap justify-end gap-1"><Chip tone={state.tone}>{state.label}</Chip>{l.reconciled ? <Chip tone="gray">Reconciled</Chip> : null}</span>
          </div>
        </div>

        {l.matches.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {l.matches.map((m) => <li key={m.entryId}>Matched to <b>{entryType(m.type)} {m.no}</b> · {money(m.amount)} <span className="text-fg-muted">({ruleWords(m.rule)})</span></li>)}
          </ul>
        ) : null}
        {l.status === 'ignored' && has(l.ignoreReason) ? <p className="text-xs text-fg-muted">Set aside: {l.ignoreReason}</p> : null}

        {l.status === 'proposed' && l.proposals.length > 0 ? (
          <div className="space-y-1" role="group" aria-label="Suggested matches">
            <p className="text-xs font-semibold text-fg-muted">Looks like:</p>
            {l.proposals.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
                <span><b>{entryType(e.type)} {e.no}</b> · {e.date} · {money(e.amount)}{e.description === '' ? '' : ` · ${e.description}`}</span>
                {view.can.match ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act('Matched.', () => matchStatementLineAction(acc.id, l.id, [e.id]))}>Yes, match it</button> : null}
              </div>
            ))}
          </div>
        ) : null}

        {l.reconciled ? null : (
          <div className="flex flex-wrap gap-2">
            {open && view.can.match ? <button type="button" className={buttonClass} disabled={busy} aria-expanded={p?.kind === 'find'} onClick={() => void openFind(l)}>Find in our records</button> : null}
            {open && !out && view.can.createReceipt && view.methodCount > 0 ? <button type="button" className={buttonClass} disabled={busy} aria-expanded={p?.kind === 'customer'} onClick={() => { close(); setPanel({ id: l.id, kind: 'customer' }); }}>It is a customer&apos;s payment</button> : null}
            {open && out && view.can.recordCharge && !acc.hasFeeAccount ? <Chip tone="amber">No fee account set (Bank accounts)</Chip> : null}
            {open && out && view.can.recordCharge && acc.hasFeeAccount ? (
              <span className="flex flex-wrap items-center gap-2">
                {needsGlChoice ? <div className="min-w-56"><ChoicePicker label="G/L account the charge came out of" hideLabel source="statement-charge-accounts" filters={{ account: acc.id }} choice={chargeGl} onChoice={setChargeGl} placeholder="Which G/L account?" /></div> : null}
                <button type="button" className={buttonClass} disabled={busy || (needsGlChoice && chargeGl === null)} onClick={() => void act('Charge recorded and matched.', () => chargeFromStatementLineAction(acc.id, l.id, needsGlChoice ? chargeGl?.id : undefined))}>Record as a bank charge</button>
              </span>
            ) : null}
            {open && view.can.ignore ? <button type="button" className={buttonClass} disabled={busy} aria-expanded={p?.kind === 'ignore'} onClick={() => { close(); setPanel({ id: l.id, kind: 'ignore' }); }}>Set aside</button> : null}
            {l.status === 'matched' && view.can.unmatch ? <button type="button" className={dangerClass} disabled={busy} aria-expanded={p?.kind === 'unmatch'} onClick={() => { close(); setPanel({ id: l.id, kind: 'unmatch' }); }}>Undo match</button> : null}
            {l.status === 'ignored' && view.can.ignore ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act('Brought back.', () => restoreStatementLineAction(acc.id, l.id))}>Bring back</button> : null}
          </div>
        )}

        {p?.kind === 'find' ? <FindEntriesPanel lineAmount={l.amount} candidates={candidates} busy={busy} onMatch={(ids) => void act('Matched.', () => matchStatementLineAction(acc.id, l.id, ids))} onClose={close} /> : null}
        {p?.kind === 'customer' ? <CustomerReceiptPanel accountId={acc.id} lineAmount={l.amount} lineDate={l.date} busy={busy} onCreate={(input) => void act('Receipt created, posted and matched.', () => receiptFromStatementLineAction(acc.id, l.id, input))} onClose={close} /> : null}
        {p?.kind === 'ignore' ? <ReasonPanel kind="ignore" busy={busy} onSubmit={(r) => void act('Set aside.', () => ignoreStatementLineAction(acc.id, l.id, r))} onClose={close} /> : null}
        {p?.kind === 'unmatch' ? <ReasonPanel kind="unmatch" busy={busy} onSubmit={(r) => void act('Match undone.', () => unmatchStatementLineAction(acc.id, l.id, r))} onClose={close} /> : null}
      </li>
    );
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`${acc.code} — ${acc.name}`}
        intro={<span>In our books {acc.currency} <b>{money(view.bookBalance)}</b> · {toDo} {plural(toDo, 'line', 'lines')} to deal with · {view.outstandingCount} of our {plural(view.outstandingCount, 'entry', 'entries')} not on a statement yet</span>}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/finance/bank-statements" className={buttonClass}>All accounts</Link>
            {view.can.match ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void autoMatch()}>Match automatically</button> : null}
            <button type="button" className={buttonClass} aria-expanded={settings !== null} onClick={() => setSettings(settings === null ? { rules: bankMatchRulesAction(acc.id), feed: bankFeedStatusAction(acc.id) } : null)}>Rules and feed</button>
            {view.can.import ? <button type="button" className={primaryClass} aria-expanded={importing} onClick={() => setImporting(!importing)}>Import a statement</button> : null}
          </div>
        }
      />
      <Message notice={notice} />
      {settings !== null ? <StatementSettingsPanel bankAccountId={acc.id} loads={settings} onClose={() => setSettings(null)} /> : null}
      {importing ? <StatementImportPanel bankAccountId={acc.id} onClose={() => { setImporting(false); void reload(); }} /> : null}

      <div role="group" aria-label="Show lines" className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} aria-pressed={filter === 'open'} onClick={() => void show('open')}>To deal with ({toDo})</button>
        <button type="button" className={buttonClass} aria-pressed={filter === 'matched'} onClick={() => void show('matched')}>Matched ({view.counts.matched})</button>
        <button type="button" className={buttonClass} aria-pressed={filter === 'ignored'} onClick={() => void show('ignored')}>Set aside ({view.counts.ignored})</button>
      </div>
      {view.lines.length === 0 ? <p className="text-sm text-fg-muted">{emptyText}</p> : <ul className="space-y-3">{view.lines.map(lineCard)}</ul>}
      {view.nextAfter === null ? null : <button type="button" className={buttonClass} onClick={() => void more()}>Show more</button>}

      <ReconcilePanel key={`${view.counts.unmatched}-${view.counts.proposed}-${view.counts.matched}-${view.counts.ignored}-${view.counts.unreconciled}-${view.reconciliations.length}-${view.reconciliations.filter((r) => r.status === 'posted').length}`} view={view} onDone={async (text) => { setNotice({ kind: 'ok', text }); await reload(); }} />

      <section className={`${cardClass} space-y-2`} aria-label="Our entries not yet on a statement">
        <h2 className="text-sm font-bold text-fg-strong">Ours, not on a statement yet ({view.outstandingCount}, net {money(view.outstandingNet)})</h2>
        <p className="text-xs text-fg-muted">Recorded in our books for this account but not seen on any imported line: payments in transit, or money the bank has not yet shown.</p>
        {view.outstanding.length === 0 ? <p className="text-sm text-fg-muted">None.</p> : null}
        {view.outstanding.length > 0 ? (
          <ul className="divide-y divide-line text-xs">
            {view.outstanding.map((e) => <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2"><span><b>{entryType(e.type)} {e.no}</b> · {e.date}{e.description === '' ? '' : ` · ${e.description}`}</span><b className={isOutgoing(e.amount) ? 'text-red-700' : 'text-green-700'}>{money(e.amount)}</b></li>)}
          </ul>
        ) : null}
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
