'use client';

import { useId, useState } from 'react';
import { postBankReconciliationAction, reconciliationPreviewAction, reverseBankReconciliationAction } from '@/server/domains/finance/bank-statement-actions';
import { ReasonFields, type WorkbenchView } from './StatementWorkbenchClient';
import { Chip, Field, Message, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, today, type Notice, attempt } from './ui';

const cents = (v: string) => Math.round(Number(v) * 100);

/** The bank's closing balance against the opening balance plus every line dealt with, to the cent. */
export function ReconcilePanel({ view, onDone }: { view: WorkbenchView; onDone: (text: string) => Promise<void> }) {
  const uid = useId();
  const [preview, setPreview] = useState(view.preview);
  const [date, setDate] = useState(today());
  const [balance, setBalance] = useState(view.preview.suggestedStatementBalance ? String(Number(view.preview.suggestedStatementBalance).toFixed(2)) : '');
  const [opening, setOpening] = useState(view.preview.suggestedOpening ? String(Number(view.preview.suggestedOpening).toFixed(2)) : '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState({ code: '', text: '' });
  const acc = view.account;

  const changeDate = async (d: string) => {
    setDate(d);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const res = await attempt(reconciliationPreviewAction(acc.id, d));
    if (res.ok) {
      setPreview(res.data);
      if (res.data.suggestedStatementBalance) setBalance(Number(res.data.suggestedStatementBalance).toFixed(2));
    }
  };
  const openingCents = preview.needsOpening ? (opening === '' ? null : cents(opening)) : cents(preview.previous?.balance ?? '0');
  const expected = openingCents === null ? null : openingCents + cents(preview.linesTotal);
  const diff = expected === null || balance === '' ? null : cents(balance) - expected;
  const canPost = view.can.reconcile && preview.blockingCount === 0 && preview.lineCount > 0 && diff === 0;
  const latestPosted = view.reconciliations.find((r) => r.status === 'posted');

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(postBankReconciliationAction({ bankAccountId: acc.id, statementDate: date, statementBalance: balance, openingBalance: preview.needsOpening ? opening : undefined, notes: notes || undefined }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    await onDone(`Reconciliation ${res.data.number} posted: ${res.data.lines} line${res.data.lines === 1 ? '' : 's'} closed.`);
  };
  const reverse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reversing) return;
    setBusy(true);
    const res = await attempt(reverseBankReconciliationAction(acc.id, reversing, { code: reason.code, text: reason.text.trim() || undefined }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setReversing(null);
    setReason({ code: '', text: '' });
    await onDone('Reconciliation reversed: its lines can be changed again.');
  };

  return (
    <section className={`${cardClass} space-y-4`} aria-label="Reconcile with the statement">
      <h2 className="text-sm font-bold text-fg-strong">Reconcile with the bank</h2>
      <Message notice={notice} />
      {preview.blockingCount > 0 ? <p className="text-xs font-semibold text-amber-700" role="status">{preview.blockingCount} line{preview.blockingCount === 1 ? '' : 's'} up to that date still need dealing with before this can be posted.</p> : null}
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
          <div><dt className="text-fg-muted">Opening plus lines</dt><dd className="font-bold tabular-nums">{expected === null ? '—' : money((expected / 100).toFixed(2))}</dd></div>
          <div><dt className="text-fg-muted">Difference</dt><dd className={`font-bold tabular-nums ${diff === 0 ? 'text-green-700' : 'text-red-700'}`}>{diff === null ? '—' : diff === 0 ? 'None: they agree' : money((diff / 100).toFixed(2))}</dd></div>
          <div><dt className="text-fg-muted">Set aside in this</dt><dd className="font-bold">{preview.ignoredCount} · {money(preview.ignoredTotal)}</dd></div>
        </dl>
        <details className="text-xs">
          <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-600">How this compares with our books</summary>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
            <div><dt className="text-fg-muted">Bank ledger to that date</dt><dd className="font-semibold tabular-nums">{money(preview.bookBalance)}</dd></div>
            <div><dt className="text-fg-muted">Not on a statement ({preview.outstandingCount})</dt><dd className="font-semibold tabular-nums">{money(preview.outstandingNet)}</dd></div>
            <div><dt className="text-fg-muted">General ledger account</dt><dd className="font-semibold tabular-nums">{money(preview.glBalance)}</dd></div>
            <div><dt className="text-fg-muted">Books minus not-yet-seen</dt><dd className="font-semibold tabular-nums">{money((cents(preview.bookBalance) / 100 - cents(preview.outstandingNet) / 100).toFixed(2))}</dd></div>
          </dl>
        </details>
        <Field id={`${uid}-n`} label="Note (optional)"><input id={`${uid}-n`} value={notes} onChange={(e) => setNotes(e.target.value)} className={fieldClass} maxLength={300} autoComplete="off" /></Field>
        {view.can.reconcile ? <button type="submit" className={primaryClass} disabled={busy || !canPost}>Post reconciliation</button> : <p className="text-xs text-fg-muted">You can look, but posting a reconciliation needs another permission.</p>}
      </form>

      {view.reconciliations.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-fg-muted">Earlier reconciliations</h3>
          <ul className="space-y-1 text-xs">
            {view.reconciliations.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                <span><b>{r.number}</b> · to {r.date} · {money(r.balance)} · {r.lines} line{r.lines === 1 ? '' : 's'} {r.status === 'reversed' ? <Chip tone="gray">Reversed</Chip> : null}</span>
                {r.status === 'posted' && r.id === latestPosted?.id && view.can.reverse ? <button type="button" className={dangerClass} disabled={busy} aria-expanded={reversing === r.id} onClick={() => setReversing(reversing === r.id ? null : r.id)}>Reverse</button> : null}
              </li>
            ))}
          </ul>
          {reversing ? (
            <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => void reverse(e)}>
              <p className="text-xs text-fg-muted">Only the latest reconciliation can be reversed. Its lines can then be changed again.</p>
              <ReasonFields id={`${uid}-rv`} reasons={view.reasons} value={reason} onChange={setReason} />
              <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy}>Reverse it</button><button type="button" className={buttonClass} onClick={() => setReversing(null)}>Keep it</button></div>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
