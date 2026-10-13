'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { freezeWalletAction, reverseWalletUseAction, useWalletAction, type customerWalletAction } from '@/server/domains/finance/wallet-actions';
import { Chip, Field, Message, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

export type WalletView = Extract<Awaited<ReturnType<typeof customerWalletAction>>, { ok: true }>['data'];

const TYPE: Record<string, string> = {
  deposit: 'Advance deposit',
  overpayment: 'Overpayment kept',
  utilisation: 'Used on invoices',
  tender: 'Paid an order',
  credit_note: 'Credit note excess kept',
  cash_out: 'Paid out as a refund',
  reversal: 'Put back',
};

/** A customer's wallet on their account page: balance, what moved, and the things a person may do with it. */
export function CustomerWalletPanel({ customerId, view }: { customerId: string; view: WalletView }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [using, setUsing] = useState<string | null>(null); // currency
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<number | null>(null);
  const [reason, setReason] = useState({ code: '', text: '' });
  const label = view.label;
  const lc = label.toLowerCase();

  const done = (res: { ok: true } | { ok: false; error: string }, ok: string) => {
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: ok } : { kind: 'error', text: res.error });
    if (res.ok) { setUsing(null); setUndo(null); setReason({ code: '', text: '' }); setAmounts({}); }
    router.refresh();
  };

  const fill = (currency: string, balance: string) => {
    let left = Math.round(Number(balance) * 100);
    const next: Record<string, string> = {};
    for (const inv of view.openInvoices.filter((i) => i.currency === currency)) {
      if (left <= 0) break;
      const take = Math.min(left, Math.round(Number(inv.remaining) * 100));
      next[inv.entryId] = (take / 100).toFixed(2);
      left -= take;
    }
    setAmounts(next);
  };

  if (!view.walletEnabled && view.wallets.length === 0 && view.entries.length === 0) {
    return <p className="text-xs text-fg-muted">The {lc} is not switched on. It is set under Finance → Wallet policy.</p>;
  }

  return (
    <section className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-w`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${uid}-w`} className="text-sm font-bold text-fg-strong">{label}</h3>
        {!view.walletEnabled ? <Chip tone="amber">Switched off</Chip> : null}
      </div>
      <Message notice={notice} />
      {view.wallets.length === 0 ? <p className="text-sm text-fg-muted">Nothing is held for this customer yet.</p> : null}
      {view.wallets.map((w) => (
        <div key={w.id} className="space-y-3 rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-lg font-bold tabular-nums text-fg-strong">{w.currency} {money(w.balance)} {w.status === 'frozen' ? <Chip tone="red">Frozen</Chip> : null}</p>
            <div className="flex flex-wrap gap-2">
              {view.can.utilise && Number(w.balance) > 0 && w.status === 'active' ? (
                <Link href={`/admin/finance/refunds/new?customer=${customerId}&source=wallet:${w.id}`} className={buttonClass}>Pay out as a refund</Link>
              ) : null}
              {view.can.utilise && Number(w.balance) > 0 && w.status === 'active' ? (
                <button type="button" className={primaryClass} disabled={busy} onClick={() => { setUsing(using === w.currency ? null : w.currency); fill(w.currency, w.balance); }} aria-expanded={using === w.currency}>Pay invoices from the {lc}</button>
              ) : null}
              {view.can.freeze ? (
                <button type="button" className={buttonClass} disabled={busy} onClick={async () => { setBusy(true); done(await attempt(freezeWalletAction(customerId, w.currency, w.status === 'active')), w.status === 'active' ? 'Frozen.' : 'Unfrozen.'); }}>
                  {w.status === 'active' ? 'Freeze' : 'Unfreeze'}
                </button>
              ) : null}
            </div>
          </div>
          {using === w.currency ? (
            <form
              aria-label={`Pay invoices from the ${lc}`}
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const apps = Object.entries(amounts).filter(([, v]) => Number(v) > 0).map(([entryId, amount]) => ({ entryId, amount }));
                setBusy(true);
                const res = await attempt(useWalletAction(customerId, w.currency, apps));
                done(res, res.ok ? `Paid ${money(res.data.used)} from the ${lc}.` : '');
              }}
            >
              {view.openInvoices.filter((i) => i.currency === w.currency).length === 0 ? <p className="text-sm text-fg-muted">There are no unpaid invoices in {w.currency}.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[26rem] text-left text-xs">
                    <caption className="sr-only">Unpaid invoices</caption>
                    <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">Invoice</th><th scope="col" className="pr-3">Due</th><th scope="col" className="pr-3 text-right">Owed</th><th scope="col" className="text-right">Pay</th></tr></thead>
                    <tbody>
                      {view.openInvoices.filter((i) => i.currency === w.currency).map((inv) => (
                        <tr key={inv.entryId} className="border-t border-line">
                          <td className="py-1.5 pr-3 font-semibold">{inv.documentNo}</td>
                          <td className="pr-3 whitespace-nowrap">{inv.dueDate ?? '—'}</td>
                          <td className="pr-3 text-right tabular-nums">{money(inv.remaining)}</td>
                          <td className="text-right"><input aria-label={`Amount to pay on ${inv.documentNo}`} value={amounts[inv.entryId] ?? ''} onChange={(e) => setAmounts({ ...amounts, [inv.entryId]: e.target.value })} className={`${fieldClass} ml-auto w-28 text-right tabular-nums`} inputMode="decimal" placeholder="0.00" autoComplete="off" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-sm text-fg" aria-live="polite">Paying {w.currency} {money(Object.values(amounts).reduce((n, v) => n + (Number(v) || 0), 0).toFixed(2))} of the {money(w.balance)} held.</p>
              <div className="flex gap-2">
                <button type="button" className={buttonClass} onClick={() => fill(w.currency, w.balance)}>Fill oldest first</button>
                <button type="submit" className={primaryClass} disabled={busy || Object.values(amounts).every((v) => !(Number(v) > 0)) || Object.values(amounts).reduce((n, v) => n + (Number(v) || 0), 0) > Number(w.balance) + 0.001}>Pay</button>
                <button type="button" className={buttonClass} onClick={() => setUsing(null)}>Cancel</button>
              </div>
            </form>
          ) : null}
        </div>
      ))}

      {undo !== null ? (
        <form
          aria-label={`Undo this use of the ${lc}`}
          className="space-y-3 rounded-xl border border-line p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            done(await attempt(reverseWalletUseAction(customerId, undo, { code: reason.code, text: reason.text.trim() || undefined })), 'Undone. The invoices are owed again and the money is back.');
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-r`} label="Reason">
              <select id={`${uid}-r`} value={reason.code} onChange={(e) => setReason({ ...reason, code: e.target.value })} className={fieldClass} required>
                <option value="">Choose a reason…</option>
                {view.reasons.map((r) => <option key={r.code} value={r.code}>{r.description}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-rt`} label={view.reasons.find((r) => r.code === reason.code)?.requiresComment ? 'Explain (required)' : 'Comment (optional)'}>
              <input id={`${uid}-rt`} value={reason.text} onChange={(e) => setReason({ ...reason, text: e.target.value })} className={fieldClass} required={view.reasons.find((r) => r.code === reason.code)?.requiresComment ?? false} maxLength={300} autoComplete="off" />
            </Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || !reason.code}>Undo the use</button><button type="button" className={buttonClass} onClick={() => setUndo(null)}>Keep it</button></div>
        </form>
      ) : null}

      {view.entries.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-xs">
            <caption className="sr-only">Movements of the {lc}, newest first</caption>
            <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">Date</th><th scope="col" className="pr-3">What</th><th scope="col" className="pr-3 text-right">Amount</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {view.entries.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{e.date}</td>
                  <td className="pr-3">{TYPE[e.type] ?? e.type}</td>
                  <td className={`pr-3 text-right tabular-nums ${e.amount.startsWith('-') ? 'text-red-700' : 'text-emerald-700'}`}>{money(e.amount)}</td>
                  <td className="text-right">
                    {e.type === 'utilisation' && view.can.reverse && !view.entries.some((x) => x.type === 'reversal' && x.sourceType === 'wallet_entry' && x.sourceId === String(e.id)) ? (
                      <button type="button" className={buttonClass} disabled={busy} onClick={() => setUndo(e.id)} aria-label={`Undo the use on ${e.date}`}>Undo</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
