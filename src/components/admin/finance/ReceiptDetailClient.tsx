'use client';

import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { moveReceiptToWalletAction } from '@/server/domains/finance/wallet-actions';
import {
  applyReceiptAction,
  bounceChequeAction,
  cancelReceiptAction,
  chequeDepositBanksAction,
  clearChequeAction,
  depositChequeAction,
  postReceiptAction,
  receiptApplyOptionsAction,
  reverseReceiptAction,
  unapplyReceiptAction,
  type receiptDetailAction,
} from '@/server/domains/finance/receivables/actions';
import { CHEQUE_STATUS, RECEIPT_STATUS } from './ReceiptsClient';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, today, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof receiptDetailAction>>, { ok: true }>['data'];
type Reason = View['reasons'][number];

/** A reason from the company's list, with the comment box shown when that reason demands one. */
function ReasonPicker({ id, reasons, value, onChange }: { id: string; reasons: Reason[]; value: { code: string; text: string }; onChange: (v: { code: string; text: string }) => void }) {
  const chosen = reasons.find((r) => r.code === value.code);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field id={`${id}-reason`} label="Reason" hint="Kept with your name, the time and where you did this from.">
        <select id={`${id}-reason`} value={value.code} onChange={(e) => onChange({ ...value, code: e.target.value })} className={fieldClass} required>
          <option value="">Choose a reason…</option>
          {reasons.map((r) => <option key={r.code} value={r.code}>{r.description}</option>)}
        </select>
      </Field>
      <Field id={`${id}-text`} label={chosen?.requiresComment ? 'Explain (required)' : 'Comment (optional)'}>
        <input id={`${id}-text`} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} className={fieldClass} required={chosen?.requiresComment ?? false} maxLength={300} autoComplete="off" />
      </Field>
    </div>
  );
}

type Panel = null | 'cancel' | 'reverse' | 'bounce' | 'apply' | 'deposit' | { unapply: string };

export function ReceiptDetailClient({ view, postingFailed }: { view: View; postingFailed?: string }) {
  const uid = useId();
  const router = useRouter();
  const r = view.receipt;
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(postingFailed ? { kind: 'error', text: `It was saved as a draft but could not be posted: ${postingFailed}` } : null);
  const [reason, setReason] = useState({ code: '', text: '' });
  const [allocate, setAllocate] = useState<'oldest_first' | 'none'>('oldest_first');
  const [open, setOpen] = useState<{ entryId: string; documentNo: string; remaining: string; dueDate: string | null; currency: string | null }[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [banks, setBanks] = useState<{ id: string; label: string }[]>([]);
  const [bankId, setBankId] = useState('');
  const [when, setWhen] = useState(today());
  const fileRef = useRef<HTMLInputElement>(null);

  const finish = (res: { ok: true } | { ok: false; error: string }, okText: string) => {
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: okText });
    setPanel(null);
    setReason({ code: '', text: '' });
    router.refresh();
  };
  const close = () => { setPanel(null); setReason({ code: '', text: '' }); };

  const post = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(postReceiptAction(r.id, allocate));
    finish(res, res.ok ? `Posted${Number(res.data.applied) > 0 ? ` and applied ${money(res.data.applied)} to invoices` : ''}${res.data.glPosted ? '' : ' (general ledger posting is not switched on yet)'}.` : '');
  };
  const submitReason = (fn: (reason: { code: string; text?: string }) => Promise<{ ok: true } | { ok: false; error: string }>, okText: string) => async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    finish(await fn({ code: reason.code, text: reason.text.trim() || undefined }), okText);
  };

  const openApply = async () => {
    setPanel('apply');
    setOpen(null);
    const res = await attempt(receiptApplyOptionsAction(view.customer.id));
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setOpen(res.data);
    setAmounts({});
  };
  const fillOldest = () => {
    let left = Math.round(Number(view.unapplied) * 100);
    const next: Record<string, string> = {};
    for (const inv of open ?? []) {
      if (left <= 0) break;
      const take = Math.min(left, Math.round(Number(inv.remaining) * 100));
      next[inv.entryId] = (take / 100).toFixed(2);
      left -= take;
    }
    setAmounts(next);
  };
  const chosenTotal = Object.values(amounts).reduce((n, v) => n + (Number(v) || 0), 0);
  const applyNow = async (e: React.FormEvent) => {
    e.preventDefault();
    const apps = Object.entries(amounts).filter(([, v]) => Number(v) > 0).map(([entryId, amount]) => ({ entryId, amount }));
    setBusy(true);
    finish(await attempt(applyReceiptAction(r.id, apps)), 'Applied.');
  };
  const openDeposit = async () => {
    setPanel('deposit');
    const res = await attempt(chequeDepositBanksAction());
    if (res.ok) { setBanks(res.data); setBankId(res.data[0]?.id ?? ''); }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setNotice(null);
    const body = new FormData();
    body.set('file', file);
    body.set('receiptId', r.id);
    try {
      const res = await fetch('/api/admin/finance/receipt-evidence', { method: 'POST', body });
      const json = (await res.json()) as { ok: boolean; error?: string };
      setBusy(false);
      if (!json.ok) return setNotice({ kind: 'error', text: json.error ?? 'The file could not be saved.' });
      setNotice({ kind: 'ok', text: 'Evidence attached.' });
      router.refresh();
    } catch {
      setBusy(false);
      setNotice({ kind: 'error', text: 'The file could not be sent. Check your connection and try again.' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const isCheque = r.chequeStatus !== null;
  const activeApplications = view.applications.filter((a) => !a.undone);
  // One application can cover several invoices; it is undone as a whole.
  const groups = [...view.applications.reduce((m, a) => {
    const g = m.get(a.applicationId) ?? { applicationId: a.applicationId, at: a.at, undone: a.undone, total: 0, rows: [] as { invoiceNo: string; amount: string }[] };
    g.total += Number(a.amount);
    g.rows.push({ invoiceNo: a.invoiceNo, amount: a.amount });
    return m.set(a.applicationId, g);
  }, new Map<string, { applicationId: string; at: string; undone: boolean; total: number; rows: { invoiceNo: string; amount: string }[] }>()).values()];

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={`Receipt ${r.number}`}
        intro={
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={RECEIPT_STATUS[r.status]?.tone ?? 'gray'}>{RECEIPT_STATUS[r.status]?.label ?? r.status}</Chip>
            {r.chequeStatus ? <Chip tone={CHEQUE_STATUS[r.chequeStatus]?.tone ?? 'gray'}>{CHEQUE_STATUS[r.chequeStatus]?.label}</Chip> : null}
            {view.isDeposit ? <Chip tone="sky">Advance deposit</Chip> : null}
            <span>from <Link className="font-semibold text-indigo-600 hover:underline" href={`/admin/finance/receivables/customer/${view.customer.id}`}>{view.customer.name}</Link> ({view.customer.number})</span>
          </span>
        }
        actions={<Link href="/admin/finance/receipts" className={buttonClass}>All receipts</Link>}
      />
      <Message notice={notice} />

      <section className={`${cardClass} grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4`} aria-label="Receipt details">
        {([
          ['Amount', `${r.currency} ${money(r.amount)}`],
          ['Method', view.method.name],
          ['Paid into', `${view.bank.code} — ${view.bank.name}`],
          ['Date paid', r.paymentDate],
          ['Posting date', r.postingDate],
          ['Reference', r.reference ?? '—'],
          ['Paid by', r.payerName ?? '—'],
          ['Source', r.source.replace('_', ' ')],
          ...(r.status === 'posted' ? [['Not yet applied', `${r.currency} ${money(view.unapplied)}`] as [string, string]] : []),
          ...(view.depositedInto ? ([['Deposited into', view.depositedInto]] as [string, string][]) : []),
          ...(isCheque ? ([['Cheque no.', r.counterparty.chequeNo ?? '—'], ["Drawer's bank", r.counterparty.bank ?? '—'], ['Drawer', r.counterparty.drawer ?? '—']] as [string, string][]) : []),
        ] as [string, string][]).map(([k, v]) => (
          <div key={k} className="min-w-0"><dt className="text-xs text-fg-muted">{k}</dt><dd className="break-words font-semibold text-fg-strong tabular-nums">{v}</dd></div>
        ))}
        {r.narration ? <div className="col-span-full"><dt className="text-xs text-fg-muted">Notes</dt><dd className="text-fg">{r.narration}</dd></div> : null}
        {r.registerId ? <div className="col-span-full text-xs text-fg-muted">In the general ledger as document {r.number}; see it under <Link className="text-indigo-600 hover:underline" href="/admin/finance/registers">Postings</Link>.</div> : null}
      </section>

      {/* Actions the person may take now */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Receipt actions">
        {r.status === 'draft' && view.can.post ? (
          <>
            <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
              <span className="sr-only">When posting</span>
              <select value={allocate} onChange={(e) => setAllocate(e.target.value as typeof allocate)} className={`${fieldClass} w-auto`} aria-label="When posting">
                <option value="oldest_first">Apply to oldest invoices</option>
                <option value="none">Leave unapplied</option>
              </select>
            </label>
            <button type="button" className={primaryClass} disabled={busy || (view.method.requiresEvidence && view.attachments.length === 0)} onClick={post}>Post receipt</button>
          </>
        ) : null}
        {r.status === 'draft' && view.can.cancel ? <button type="button" className={buttonClass} disabled={busy} onClick={() => setPanel('cancel')}>Cancel draft</button> : null}
        {r.status === 'posted' && view.can.apply && Number(view.unapplied) > 0 ? <button type="button" className={primaryClass} disabled={busy} onClick={openApply}>Apply to invoices</button> : null}
        {r.status === 'posted' && view.wallet.enabled && view.can.moveToWallet && Number(view.unapplied) > 0 ? (
          <button type="button" className={buttonClass} disabled={busy} onClick={async () => { setBusy(true); setNotice(null); const res = await attempt(moveReceiptToWalletAction(r.id)); finish(res, res.ok ? `${money(res.data.moved)} moved to the ${view.wallet.label.toLowerCase()}.` : ''); }}>
            Move the unapplied {money(view.unapplied)} to the {view.wallet.label.toLowerCase()}
          </button>
        ) : null}
        {r.status === 'posted' && Number(view.unapplied) > 0 ? <Link href={`/admin/finance/refunds/new?customer=${view.customer.id}&source=receipt_unapplied:${r.id}`} className={buttonClass}>Refund the unapplied {money(view.unapplied)}</Link> : null}
        {r.status === 'posted' && r.chequeStatus === 'received' && view.can.deposit ? <button type="button" className={buttonClass} disabled={busy} onClick={openDeposit}>Record deposit</button> : null}
        {r.status === 'posted' && r.chequeStatus === 'deposited' && view.can.clear ? (
          <button type="button" className={buttonClass} disabled={busy} onClick={async () => { setBusy(true); finish(await attempt(clearChequeAction(r.id)), 'Cheque marked as cleared.'); }}>Mark cleared</button>
        ) : null}
        {r.status === 'posted' && isCheque && r.chequeStatus !== 'bounced' && view.can.bounce ? <button type="button" className={dangerClass} disabled={busy} onClick={() => setPanel('bounce')}>Cheque bounced</button> : null}
        {r.status === 'posted' && view.can.reverse ? <button type="button" className={dangerClass} disabled={busy} onClick={() => setPanel('reverse')}>Reverse receipt</button> : null}
      </div>
      {r.status === 'draft' && view.method.requiresEvidence && view.attachments.length === 0 ? (
        <p className="text-sm text-amber-700">This method needs evidence. Attach it below, then post.</p>
      ) : null}

      {panel === 'cancel' ? (
        <form onSubmit={submitReason((x) => cancelReceiptAction(r.id, x), 'Draft cancelled.')} className={`${cardClass} space-y-3`} aria-label="Cancel this draft">
          <ReasonPicker id={uid} reasons={view.reasons} value={reason} onChange={setReason} />
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || !reason.code}>Cancel the draft</button><button type="button" className={buttonClass} onClick={close}>Keep it</button></div>
        </form>
      ) : null}
      {panel === 'reverse' ? (
        <form onSubmit={submitReason((x) => reverseReceiptAction(r.id, x), 'Receipt reversed.')} className={`${cardClass} space-y-3`} aria-label="Reverse this receipt">
          <p className="text-sm text-fg">The money is taken back out of {view.bank.code} and the customer&apos;s account. {activeApplications.length > 0 ? 'Undo its applications to invoices first.' : ''}</p>
          <ReasonPicker id={uid} reasons={view.reasons} value={reason} onChange={setReason} />
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || !reason.code}>Reverse the receipt</button><button type="button" className={buttonClass} onClick={close}>Keep it</button></div>
        </form>
      ) : null}
      {panel === 'bounce' ? (
        <form onSubmit={submitReason((x) => bounceChequeAction(r.id, x), 'Cheque marked as bounced. The invoices it paid are open again.')} className={`${cardClass} space-y-3`} aria-label="Cheque bounced">
          <p className="text-sm text-fg">The receipt is reversed, every application to invoices is undone and those invoices become unpaid again.</p>
          <ReasonPicker id={uid} reasons={view.reasons} value={reason} onChange={setReason} />
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || !reason.code}>Record the bounce</button><button type="button" className={buttonClass} onClick={close}>Cancel</button></div>
        </form>
      ) : null}
      {panel === 'deposit' ? (
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); finish(await attempt(depositChequeAction(r.id, bankId, when)), 'Deposit recorded.'); }} className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-3`} aria-label="Record the deposit">
          <Field id={`${uid}-bank`} label="Deposited into">
            <select id={`${uid}-bank`} value={bankId} onChange={(e) => setBankId(e.target.value)} className={fieldClass} required>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </Field>
          <Field id={`${uid}-when`} label="Date deposited"><input id={`${uid}-when`} type="date" value={when} max={today()} onChange={(e) => setWhen(e.target.value)} className={fieldClass} required /></Field>
          <div className="flex items-end gap-2"><button type="submit" className={primaryClass} disabled={busy || !bankId}>Save</button><button type="button" className={buttonClass} onClick={close}>Cancel</button></div>
        </form>
      ) : null}
      {panel === 'apply' ? (
        <form onSubmit={applyNow} className={`${cardClass} space-y-3`} aria-label="Apply to invoices">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-fg">Available to apply: <strong className="tabular-nums">{r.currency} {money(view.unapplied)}</strong></p>
            <button type="button" className={buttonClass} onClick={fillOldest}>Fill oldest first</button>
          </div>
          {open === null ? <p className="text-sm text-fg-muted">Loading the customer&apos;s unpaid invoices…</p> : open.length === 0 ? <p className="text-sm text-fg-muted">This customer has no unpaid invoices.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-left text-xs">
                <caption className="sr-only">Unpaid invoices of {view.customer.name}</caption>
                <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">Invoice</th><th scope="col" className="pr-3">Due</th><th scope="col" className="pr-3 text-right">Still owed</th><th scope="col" className="text-right">Apply</th></tr></thead>
                <tbody>
                  {open.map((inv) => (
                    <tr key={inv.entryId} className="border-t border-line">
                      <td className="py-1.5 pr-3 font-semibold">{inv.documentNo}</td>
                      <td className="pr-3 whitespace-nowrap">{inv.dueDate ?? '—'}</td>
                      <td className="pr-3 text-right tabular-nums">{money(inv.remaining)}</td>
                      <td className="text-right">
                        <input
                          aria-label={`Amount to apply to ${inv.documentNo}`}
                          value={amounts[inv.entryId] ?? ''}
                          onChange={(e) => setAmounts({ ...amounts, [inv.entryId]: e.target.value })}
                          className={`${fieldClass} ml-auto w-28 text-right tabular-nums`}
                          inputMode="decimal"
                          placeholder="0.00"
                          autoComplete="off"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={`text-sm ${chosenTotal > Number(view.unapplied) + 0.001 ? 'text-red-700' : 'text-fg'}`} aria-live="polite">
            Applying {r.currency} {money(chosenTotal.toFixed(2))} of {money(view.unapplied)}.
          </p>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy || chosenTotal <= 0 || chosenTotal > Number(view.unapplied) + 0.001}>Apply</button><button type="button" className={buttonClass} onClick={close}>Cancel</button></div>
        </form>
      ) : null}
      {typeof panel === 'object' && panel !== null ? (
        <form onSubmit={submitReason((x) => unapplyReceiptAction(r.id, panel.unapply, x), 'Application undone. The invoices are unpaid again.')} className={`${cardClass} space-y-3`} aria-label="Undo this application">
          <ReasonPicker id={uid} reasons={view.reasons} value={reason} onChange={setReason} />
          <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy || !reason.code}>Undo the application</button><button type="button" className={buttonClass} onClick={close}>Keep it</button></div>
        </form>
      ) : null}

      {view.applications.length > 0 ? (
        <section className="space-y-3" aria-labelledby={`${uid}-apps`}>
          <h3 id={`${uid}-apps`} className="text-sm font-bold text-fg-strong">Applied to invoices</h3>
          {groups.map((g) => (
            <div key={g.applicationId} className="rounded-xl border border-line bg-surface-raised p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-fg">
                  {g.at.slice(0, 10)} · {g.rows.length} {g.rows.length === 1 ? 'invoice' : 'invoices'} · <span className="font-semibold tabular-nums">{r.currency} {money(g.total.toFixed(2))}</span>{' '}
                  {g.undone ? <Chip tone="gray">Undone</Chip> : <Chip tone="green">In force</Chip>}
                </p>
                {!g.undone && r.status === 'posted' && view.can.unapply ? (
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => setPanel({ unapply: g.applicationId })} aria-label={`Undo the application of ${g.at.slice(0, 10)} to ${g.rows.map((x) => x.invoiceNo).join(', ')}`}>
                    Undo this application
                  </button>
                ) : null}
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[18rem] text-left text-xs">
                  <caption className="sr-only">Invoices in the application of {g.at.slice(0, 10)}</caption>
                  <thead className="text-fg-muted"><tr><th scope="col" className="py-1 pr-3">Invoice</th><th scope="col" className="text-right">Amount</th></tr></thead>
                  <tbody>
                    {g.rows.map((x) => (
                      <tr key={x.invoiceNo} className="border-t border-line"><td className="py-1.5 pr-3 font-semibold">{x.invoiceNo}</td><td className="text-right tabular-nums">{money(x.amount)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="space-y-2" aria-labelledby={`${uid}-ev`}>
        <h3 id={`${uid}-ev`} className="text-sm font-bold text-fg-strong">Evidence</h3>
        {view.attachments.length === 0 ? <p className="text-sm text-fg-muted">Nothing attached.</p> : (
          <ul className="space-y-1">
            {view.attachments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                {a.url ? <a href={a.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-600 hover:underline">{a.fileName}</a> : <span>{a.fileName}</span>}
                <span className="text-xs text-fg-muted">added {a.createdAt.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        )}
        {view.can.attach && r.status !== 'cancelled' ? (
          <div>
            <label htmlFor={`${uid}-file`} className="mb-1 block text-xs font-semibold text-fg">Attach a photo (deposit slip, screenshot, cheque)</label>
            <input
              id={`${uid}-file`}
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
              className="block min-h-10 w-full text-sm text-fg file:mr-3 file:min-h-10 file:rounded-lg file:border file:border-line-strong file:bg-surface-sunken file:px-4 file:text-xs file:font-semibold"
            />
            <p className="mt-1 text-[11px] text-fg-muted">Images only (JPEG, PNG, WebP, GIF, AVIF). Kept privately with this receipt.</p>
          </div>
        ) : null}
      </section>

      <section className="space-y-2" aria-labelledby={`${uid}-tl`}>
        <h3 id={`${uid}-tl`} className="text-sm font-bold text-fg-strong">History</h3>
        <ol className="space-y-2">
          {view.events.map((e) => (
            <li key={e.id} className="rounded-lg border border-line bg-surface-raised p-3 text-xs">
              <p className="font-semibold text-fg-strong">{e.event.replace(/_/g, ' ')}{e.toStatus && e.fromStatus !== e.toStatus ? ` · ${e.fromStatus ?? 'new'} → ${e.toStatus}` : ''}</p>
              <p className="text-fg-muted">
                {new Date(e.at).toLocaleString()} · by {e.actorId ?? e.actorType}{e.surface ? ` · from ${e.surface}` : ''}{e.permission ? ` · allowed by ${e.permission}` : ''}
              </p>
              {e.reasonCode ? <p className="mt-0.5 text-fg">Reason: {e.reasonCode}{e.reasonText ? ` — ${e.reasonText}` : ''}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
