'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { freezeWalletAction, reverseWalletUseAction, useWalletAction as payInvoicesFromWalletAction, type customerWalletAction } from '@/server/domains/finance/wallet-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { needsComment, chosenCents, fromCents } from '@/lib/receipt-detail';
import { canPayFromWallet, canUndoUse, entryLabel, fillFromWallet, invoicesIn, walletApplications } from '@/lib/wallet-panel';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, Message, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

export type WalletView = Extract<Awaited<ReturnType<typeof customerWalletAction>>, { ok: true }>['data'];

/** A customer's wallet on their account page: balance, what moved, and the things a person may do with it. */
export function CustomerWalletPanel({ customerId, view }: { customerId: string; view: WalletView }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [using, setUsing] = useState<string | null>(null); // currency
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<number | null>(null);
  const [reason, setReason] = useState<Choice | null>(null);
  const [reasonText, setReasonText] = useState('');
  const label = view.label;
  const lc = label.toLowerCase();

  const done = (res: { ok: true } | { ok: false; error: string }, ok: string) => {
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: ok } : { kind: 'error', text: res.error });
    if (res.ok) { setUsing(null); setUndo(null); setReason(null); setReasonText(''); setAmounts({}); }
    router.refresh();
  };

  const fill = (currency: string, balance: string) => setAmounts(fillFromWallet(view.openInvoices, currency, balance));

  if (!view.walletEnabled && view.wallets.length === 0 && view.entries.length === 0) {
    return <p className="text-xs text-fg-muted">The {lc} is not switched on. It is set under Finance → Wallet policy.</p>;
  }

  return (
    <section className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-w`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${uid}-w`} className="text-sm font-bold text-fg-strong">{label}</h3>
        {view.walletEnabled ? null : <Chip tone="amber">Switched off</Chip>}
      </div>
      <Message notice={notice} />
      {view.wallets.length === 0 ? <p className="text-sm text-fg-muted">Nothing is held for this customer yet.</p> : null}
      {view.can.adjust ? <p><Link href={`/admin/finance/receivables/credit-adjustments/new?customer=${customerId}&kind=wallet_increase`} className={buttonClass}>Add goodwill or a correction…</Link></p> : null}
      {view.wallets.map((w) => (
        <div key={w.id} className="space-y-3 rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-lg font-bold tabular-nums text-fg-strong">{w.currency} {money(w.balance)} {w.status === 'frozen' ? <Chip tone="red">Frozen</Chip> : null}</p>
              {w.carried === null ? null : <p className="text-xs text-fg-muted">{w.carried}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {view.can.utilise && Number(w.balance) > 0 && w.status === 'active' ? (
                <Link href={`/admin/finance/refunds/new?customer=${customerId}&source=wallet:${w.id}`} className={buttonClass}>Pay out as a refund</Link>
              ) : null}
              {view.can.utilise && Number(w.balance) > 0 && w.status === 'active' ? (
                <button type="button" className={primaryClass} disabled={busy} onClick={() => { setUsing(using === w.currency ? null : w.currency); fill(w.currency, w.balance); }} aria-expanded={using === w.currency}>Pay invoices from the {lc}</button>
              ) : null}
              {view.can.adjust ? <Link href={`/admin/finance/receivables/credit-adjustments/new?customer=${customerId}&kind=wallet_decrease&currency=${w.currency}`} className={buttonClass}>Take some off…</Link> : null}
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
                setBusy(true);
                const res = await attempt(payInvoicesFromWalletAction(customerId, w.currency, walletApplications(amounts)));
                done(res, res.ok ? `Paid ${money(res.data.used)} from the ${lc}.` : '');
              }}
            >
              {invoicesIn(view.openInvoices, w.currency).length === 0 ? <p className="text-sm text-fg-muted">There are no unpaid invoices in {w.currency}.</p> : null}
              {invoicesIn(view.openInvoices, w.currency).length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[26rem] text-left text-xs">
                    <caption className="sr-only">Unpaid invoices</caption>
                    <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">Invoice</th><th scope="col" className="pr-3">Due</th><th scope="col" className="pr-3 text-right">Owed</th><th scope="col" className="text-right">Pay</th></tr></thead>
                    <tbody>
                      {invoicesIn(view.openInvoices, w.currency).map((inv) => (
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
              ) : null}
              <p className="text-sm text-fg" aria-live="polite">Paying {w.currency} {money(fromCents(chosenCents(amounts)))} of the {money(w.balance)} held.</p>
              <div className="flex gap-2">
                <button type="button" className={buttonClass} onClick={() => fill(w.currency, w.balance)}>Fill oldest first</button>
                <button type="submit" className={primaryClass} disabled={busy || !canPayFromWallet(amounts, w.balance)}>Pay</button>
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
            const text = reasonText.trim();
            done(await attempt(reverseWalletUseAction(customerId, undo, { code: reason?.id ?? '', text: text === '' ? undefined : text })), 'Undone. The invoices are owed again and the money is back.');
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChoicePicker label="Reason" source="wallet-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
            <Field id={`${uid}-rt`} label={needsComment(reason?.meta) ? 'Explain (required)' : 'Comment (optional)'}>
              <input id={`${uid}-rt`} value={reasonText} onChange={(e) => setReasonText(e.target.value)} className={fieldClass} required={needsComment(reason?.meta)} maxLength={300} autoComplete="off" />
            </Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || reason === null}>Undo the use</button><button type="button" className={buttonClass} onClick={() => setUndo(null)}>Keep it</button></div>
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
                  <td className="pr-3">{entryLabel(e.type)}</td>
                  <td className={`pr-3 text-right tabular-nums ${e.amount.startsWith('-') ? 'text-red-700' : 'text-emerald-700'}`}>{money(e.amount)}</td>
                  <td className="text-right">
                    {canUndoUse(view.entries, e, view.can.reverse) ? (
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
