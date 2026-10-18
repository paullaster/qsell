'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { closeRefundPayoutAction, recheckRefundPayoutAction } from '@/server/domains/finance/refund-actions';
import { attemptTone, closedNext, doubtfulAdvice, payoutState, reasonLongEnough, type PayoutAttempt } from '@/lib/refund-payout';
import { Chip, Field, Message, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from './ui';

/** What happened when the refund was sent through M-Pesa, and what a person can do when it could not be confirmed. */
export function RefundPayoutPanel({ id, payouts, canResolve }: { id: string; payouts: PayoutAttempt[]; canResolve: boolean }) {
  const router = useRouter();
  const state = payoutState(payouts);
  const [closing, setClosing] = useState(false);
  const [moneyLeft, setMoneyLeft] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  if (payouts.length === 0) return null;

  const finish = (res: { ok: true } | { ok: false; error: string }, text: string) => {
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text });
    setClosing(false);
    router.refresh();
  };
  const recheck = async () => { setBusy(true); setNotice(null); finish(await attempt(recheckRefundPayoutAction(id)), 'Asked Safaricom again. The result appears here and under Payment activity.'); };
  const close = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (moneyLeft === null) return;
    setBusy(true);
    setNotice(null);
    finish(await attempt(closeRefundPayoutAction(id, { moneyLeft, reason })), `Closed. ${closedNext(moneyLeft)}`);
  };

  return (
    <section className={`${cardClass} space-y-3`} aria-label="Payment through M-Pesa">
      <h2 className="text-sm font-bold text-fg-strong">Payment through M-Pesa</h2>
      <ul className="space-y-1 text-sm">
        {payouts.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2">
            <Chip tone={attemptTone(p.status)}>{p.status.replace(/_/g, ' ')}</Chip>
            <span className="text-xs text-fg-muted">{new Date(p.at).toLocaleString()}</span>
            {p.reference !== null ? <span className="font-mono text-xs">{p.reference}</span> : null}
            {p.failure !== null ? <span className="min-w-0 break-words text-xs text-fg-muted">{p.failure}</span> : null}
          </li>
        ))}
      </ul>
      <Message notice={notice} />
      {state.kind === 'doubtful' && canResolve ? (
        <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-sm text-fg">{doubtfulAdvice(state.canRecheck)}</p>
          <div className="flex flex-wrap gap-2">
            {state.canRecheck ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void recheck()}>Check with Safaricom again</button> : null}
            <button type="button" className={buttonClass} disabled={busy} aria-expanded={closing} onClick={() => setClosing(true)}>Close this attempt…</button>
          </div>
          {closing ? (
            <form onSubmit={(e) => void close(e)} className="space-y-3" aria-label="Close this attempt">
              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold text-fg-muted">What does the M-Pesa statement show?</legend>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"><input type="radio" name="money-left" checked={moneyLeft === false} onChange={() => setMoneyLeft(false)} /> The money did not leave: the refund can be sent again</label>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"><input type="radio" name="money-left" checked={moneyLeft === true} onChange={() => setMoneyLeft(true)} /> The money left: I will record the payment by hand</label>
              </fieldset>
              <Field id="close-reason" label="What you found (kept with your name)"><textarea id="close-reason" rows={2} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required /></Field>
              <div className="flex gap-2">
                <button type="submit" className={primaryClass} disabled={busy || moneyLeft === null || !reasonLongEnough(reason)}>Close the attempt</button>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => setClosing(false)}>Not now</button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
      {state.kind === 'doubtful' && !canResolve ? <p className="text-sm text-fg-muted">This payment could not be confirmed. A person with permission to resolve payouts needs to look at it.</p> : null}
    </section>
  );
}
