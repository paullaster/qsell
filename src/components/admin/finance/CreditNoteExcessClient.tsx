'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  creditNoteExcessApplyAction,
  creditNoteExcessToWalletAction,
  creditNoteOpenInvoicesAction,
  type creditNoteExcessWorklistAction,
} from '@/server/domains/finance/credit-note-actions';
import { Chip, Message, PageHeader, buttonClass, cardClass, money, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof creditNoteExcessWorklistAction>>, { ok: true }>['data'];

/** Credit notes whose customer is owed something the invoice could not absorb. Each needs a decision. */
export function CreditNoteExcessClient({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [asking, setAsking] = useState<{ id: string; invoices: { entryId: string; documentNo: string; remaining: string; dueDate: string | null }[] } | null>(null);
  const wl = view.walletLabel.toLowerCase();

  const finish = (res: { ok: true } | { ok: false; error: string }, ok: string) => {
    setBusy(null);
    setNotice(res.ok ? { kind: 'ok', text: ok } : { kind: 'error', text: res.error });
    if (res.ok) setAsking(null);
    router.refresh();
  };
  const toWallet = async (id: string) => {
    setBusy(id);
    finish(await attempt(creditNoteExcessToWalletAction(id)), `Put in the ${wl}.`);
  };
  const askInvoices = async (id: string) => {
    setBusy(id);
    const res = await attempt(creditNoteOpenInvoicesAction(id));
    setBusy(null);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setAsking({ id, invoices: res.data });
  };
  const apply = async (id: string) => {
    setBusy(id);
    const res = await attempt(creditNoteExcessApplyAction(id, 'oldest_first'));
    finish(res, res.ok ? `${money(res.data.applied)} used on the customer's unpaid invoices.` : '');
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Credit note excess"
        intro="A credit note can be bigger than what the customer still owes on the invoice (it was already paid, or paid at the sale). The difference is owed to them, and stays on this list until someone decides what to do with it."
      />
      <Message notice={notice} />
      {view.rows.length === 0 ? (
        <p className="text-sm text-fg-muted">Every credit note has been settled.</p>
      ) : (
        <ul className="space-y-3">
          {view.rows.map((r) => (
            <li key={r.creditNoteId} className={`${cardClass} space-y-3`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-fg-strong">{r.creditNoteNo} <span className="font-normal text-fg-muted">· order {r.order} · {r.reason.replace(/_/g, ' ')}</span></p>
                  <p className="text-xs text-fg"><Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/receivables/customer/${r.customerId}`}>{r.customer}</Link> ({r.customerNumber})</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold tabular-nums text-fg-strong">{r.currency} {money(r.open)}</p>
                  <p className="text-[11px] text-fg-muted">owed to the customer</p>
                </div>
              </div>
              <p className="text-xs text-fg-muted">Credited {money(r.credited)}; {money(r.takenOffInvoice)} came off the invoice.</p>
              {view.can.resolve ? (
                <div className="flex flex-wrap gap-2">
                  {view.walletEnabled ? (
                    <button type="button" className={primaryClass} disabled={busy !== null} onClick={() => void toWallet(r.creditNoteId)}>Put {money(r.open)} in the {wl}</button>
                  ) : <Chip tone="amber">The {wl} is off (Wallet policy)</Chip>}
                  <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void askInvoices(r.creditNoteId)} aria-expanded={asking?.id === r.creditNoteId}>Use on the customer&apos;s other invoices</button>
                  <Link href={`/admin/finance/refunds/new?customer=${r.customerId}&source=credit_note_excess:${r.creditNoteId}`} className={buttonClass}>Refund to the customer</Link>
                </div>
              ) : null}
              {asking?.id === r.creditNoteId ? (
                <div className="space-y-2 rounded-lg border border-line p-3" aria-live="polite" id={`${uid}-${r.creditNoteId}`}>
                  {asking.invoices.length === 0 ? <p className="text-sm text-fg-muted">This customer has no unpaid invoices.</p> : (
                    <>
                      <p className="text-sm text-fg">It will be used on, oldest first:</p>
                      <ul className="text-xs text-fg-muted">{asking.invoices.map((i) => <li key={i.entryId}>{i.documentNo} — owes {money(i.remaining)}{i.dueDate ? `, due ${i.dueDate}` : ''}</li>)}</ul>
                      <div className="flex gap-2"><button type="button" className={primaryClass} disabled={busy !== null} onClick={() => void apply(r.creditNoteId)}>Use it</button><button type="button" className={buttonClass} onClick={() => setAsking(null)}>Cancel</button></div>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
