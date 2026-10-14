'use client';

import { useId, useState } from 'react';
import { postBankReconciliationAction, reconciliationPreviewAction, reverseBankReconciliationAction } from '@/server/domains/finance/bank-statement-actions';
import { booksNotYetSeen, fromCents, isDate, plural, reconcile, twoPlaces } from '@/lib/bank-statement';
import { has } from '@/lib/finance-history';
import { NO_REASON, ReasonFields, type Reason } from './StatementLinePanels';
import type { WorkbenchView } from './StatementWorkbenchClient';
import { Chip, Field, Message, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, today, type Notice, attempt } from './ui';

/** The words under "Difference": none, or how far apart the two are. */
function differenceText(diffCents: number | null): string {
  if (diffCents === null) return '—';
  return diffCents === 0 ? 'None: they agree' : money(fromCents(diffCents));
}

/** The bank's closing balance against the opening balance plus every line dealt with, to the cent. */
export function ReconcilePanel({ view, onDone }: { view: WorkbenchView; onDone: (text: string) => Promise<void> }) {
  const uid = useId();
  const [preview, setPreview] = useState(view.preview);
  const [date, setDate] = useState(today());
  const [balance, setBalance] = useState(twoPlaces(view.preview.suggestedStatementBalance));
  const [opening, setOpening] = useState(twoPlaces(view.preview.suggestedOpening));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason>(NO_REASON);
  const acc = view.account;

  const changeDate = async (d: string) => {
    setDate(d);
    if (!isDate(d)) return;
    const res = await attempt(reconciliationPreviewAction(acc.id, d));
    if (res.ok) {
      setPreview(res.data);
      if (has(res.data.suggestedStatementBalance)) setBalance(twoPlaces(res.data.suggestedStatementBalance));
    }
  };
  const rec = reconcile(preview, opening, balance, view.can.reconcile);
  const latestPosted = view.reconciliations.find((r) => r.status === 'posted');

  const post = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(postBankReconciliationAction({ bankAccountId: acc.id, statementDate: date, statementBalance: balance, openingBalance: preview.needsOpening ? opening : undefined, notes: notes === '' ? undefined : notes }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    await onDone(`Reconciliation ${res.data.number} posted: ${res.data.lines} ${plural(res.data.lines, 'line', 'lines')} closed.`);
  };
  const reverse = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (reversing === null) return;
    setBusy(true);
    const text = reason.text.trim();
    const res = await attempt(reverseBankReconciliationAction(acc.id, reversing, { code: reason.choice?.id ?? '', text: text === '' ? undefined : text }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setReversing(null);
    setReason(NO_REASON);
    await onDone('Reconciliation reversed: its lines can be changed again.');
  };

  return (
    <section className={`${cardClass} space-y-4`} aria-label="Reconcile with the statement">
      <h2 className="text-sm font-bold text-fg-strong">Reconcile with the bank</h2>
      <Message notice={notice} />
      {preview.blockingCount > 0 ? <p className="text-xs font-semibold text-amber-700" role="status">{preview.blockingCount} {plural(preview.blockingCount, 'line', 'lines')} up to that date still need dealing with before this can be posted.</p> : null}
      <form className="space-y-3" onSubmit={(e) => void post(e)}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field id={`${uid}-d`} label="Statement date" hint="The last day the bank balance below is for."><input id={`${uid}-d`} type="date" max={today()} value={date} onChange={(e) => void changeDate(e.target.value)} className={fieldClass} required /></Field>
          <Field id={`${uid}-b`} label={`Bank's closing balance (${acc.currency})`}><input id={`${uid}-b`} inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} className={fieldClass} required /></Field>
          {preview.needsOpening ? (
            <Field id={`${uid}-o`} label="Balance before the first line" hint="First reconciliation of this account only."><input id={`${uid}-o`} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} className={fieldClass} required /></Field>
          ) : (
            <div className="text-xs"><p className="text-fg-muted">Opening (from {preview.previous?.number})</p><p className="text-sm font-bold tabular-nums">{money(preview.previous?.balance)}</p></div>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs md:grid-cols-4" aria-live="polite">
          <div><dt className="text-fg-muted">Lines to close</dt><dd className="font-bold">{preview.lineCount} · {money(preview.linesTotal)}</dd></div>
          <div><dt className="text-fg-muted">Opening plus lines</dt><dd className="font-bold tabular-nums">{rec.expectedCents === null ? '—' : money(fromCents(rec.expectedCents))}</dd></div>
          <div><dt className="text-fg-muted">Difference</dt><dd className={`font-bold tabular-nums ${rec.diffCents === 0 ? 'text-green-700' : 'text-red-700'}`}>{differenceText(rec.diffCents)}</dd></div>
          <div><dt className="text-fg-muted">Set aside in this</dt><dd className="font-bold">{preview.ignoredCount} · {money(preview.ignoredTotal)}</dd></div>
        </dl>
        <details className="text-xs">
          <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-600">How this compares with our books</summary>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
            <div><dt className="text-fg-muted">Bank ledger to that date</dt><dd className="font-semibold tabular-nums">{money(preview.bookBalance)}</dd></div>
            <div><dt className="text-fg-muted">Not on a statement ({preview.outstandingCount})</dt><dd className="font-semibold tabular-nums">{money(preview.outstandingNet)}</dd></div>
            <div><dt className="text-fg-muted">General ledger account</dt><dd className="font-semibold tabular-nums">{money(preview.glBalance)}</dd></div>
            <div><dt className="text-fg-muted">Books minus not-yet-seen</dt><dd className="font-semibold tabular-nums">{money(booksNotYetSeen(preview))}</dd></div>
          </dl>
        </details>
        <Field id={`${uid}-n`} label="Note (optional)"><input id={`${uid}-n`} value={notes} onChange={(e) => setNotes(e.target.value)} className={fieldClass} maxLength={300} autoComplete="off" /></Field>
        {view.can.reconcile ? <button type="submit" className={primaryClass} disabled={busy || !rec.canPost}>Post reconciliation</button> : <p className="text-xs text-fg-muted">You can look, but posting a reconciliation needs another permission.</p>}
      </form>

      {view.reconciliations.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-fg-muted">Earlier reconciliations</h3>
          <ul className="space-y-1 text-xs">
            {view.reconciliations.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                <span><b>{r.number}</b> · to {r.date} · {money(r.balance)} · {r.lines} {plural(r.lines, 'line', 'lines')} {r.status === 'reversed' ? <Chip tone="gray">Reversed</Chip> : null}</span>
                {r.status === 'posted' && r.id === latestPosted?.id && view.can.reverse ? <button type="button" className={dangerClass} disabled={busy} aria-expanded={reversing === r.id} onClick={() => setReversing(reversing === r.id ? null : r.id)}>Reverse</button> : null}
              </li>
            ))}
          </ul>
          {reversing === null ? null : (
            <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => void reverse(e)}>
              <p className="text-xs text-fg-muted">Only the latest reconciliation can be reversed. Its lines can then be changed again.</p>
              <ReasonFields id={`${uid}-rv`} value={reason} onChange={setReason} />
              <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || reason.choice === null}>Reverse it</button><button type="button" className={buttonClass} onClick={() => setReversing(null)}>Keep it</button></div>
            </form>
          )}
        </div>
      ) : null}
    </section>
  );
}
