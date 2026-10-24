'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveBankChangeAction, recordBankCallbackAction, rejectBankChangeAction, type bankChangesAction } from '@/server/domains/vendors/admin-actions';
import { maskAccount } from '@/lib/vendor-profile';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof bankChangesAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];
type Result = { ok: true } | { ok: false; error: string };

const STAGE = {
  awaiting_callback: { tone: 'amber', text: 'Needs a call-back to the vendor' },
  awaiting_approval: { tone: 'sky', text: 'Call-back done · needs a second person to approve' },
  cooling_off: { tone: 'gray', text: 'Approved · waiting out the cool-off' },
} as const;

export function BankChangesClient({ initialPromise }: { initialPromise: ReturnType<typeof bankChangesAction> }) {
  const res = use(initialPromise);
  return res.ok ? <BankChangesView page={res.data} /> : <LoadFailed error={res.error} />;
}

function BankChangesView({ page }: { page: Page }) {
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Vendor bank changes" intro="A vendor asked to add or replace a bank account. The change is never used until you phone the vendor on the number in our own records, a second person approves, and the cool-off has passed." />
      {page.rows.length === 0 ? <p className={`${cardClass} text-sm text-fg-muted`}>No bank changes are waiting.</p> : (
        <ul className="space-y-3" aria-label="Bank changes waiting">
          {page.rows.map((r) => <li key={r.id}><ChangeCard row={r} page={page} /></li>)}
        </ul>
      )}
    </div>
  );
}

function ChangeCard({ row, page }: { row: Row; page: Page }) {
  const uid = useId();
  const router = useRouter();
  const [mode, setMode] = useState<null | 'callback' | 'reject'>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const stage = STAGE[row.stage];
  const iCalled = row.callbackBy === page.me;

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
    setNote('');
    router.refresh();
  };

  return (
    <article className={`${cardClass} space-y-2`} aria-label={`Bank change for ${row.vendorName}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-fg-strong"><Link href={`/admin/vendors/${row.vendorId}`} className="text-indigo-600 hover:underline">{row.vendorName}</Link>{row.vendorNumber === null ? '' : ` · ${row.vendorNumber}`}</h3>
        <Chip tone={stage.tone}>{stage.text}</Chip>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-fg-muted">New account</dt><dd className="font-medium text-fg-strong">{row.bankName}, {row.branch} · {row.accountName} {maskAccount(row.last4)}</dd></div>
        <div><dt className="text-xs text-fg-muted">Replaces</dt><dd className="font-medium text-fg-strong">{row.replaces === null ? 'Nothing: an additional account' : `${row.replaces.bankName} ${maskAccount(row.replaces.last4)}`}</dd></div>
        <div><dt className="text-xs text-fg-muted">Asked</dt><dd>{new Date(row.proposedAt).toLocaleString()}</dd></div>
        {row.effectiveFrom === null ? null : <div><dt className="text-xs text-fg-muted">In use from</dt><dd>{new Date(row.effectiveFrom).toLocaleDateString()}</dd></div>}
        {row.callbackNote === null ? null : <div className="sm:col-span-2"><dt className="text-xs text-fg-muted">Call-back</dt><dd>{row.callbackNote}</dd></div>}
      </dl>
      {row.sameAccountOnOtherVendors > 0 ? <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-fg"><span className="font-semibold">Warning:</span> this account number is already held by {row.sameAccountOnOtherVendors === 1 ? 'another vendor' : `${String(row.sameAccountOnOtherVendors)} other vendors`}. Check before approving.</p> : null}
      {row.evidenceFileId !== null && page.can.viewDocuments ? <p className="text-sm"><a href={`/api/admin/vendors/files/${row.evidenceFileId}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-600 hover:underline">Open the bank letter</a></p> : null}
      <Message notice={notice} />
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          {row.stage === 'awaiting_callback' && page.can.callback ? <button type="button" className={primaryClass} disabled={busy} onClick={() => { setMode('callback'); setNote(''); }}>Record the call-back…</button> : null}
          {row.stage === 'awaiting_approval' && page.can.approve && iCalled ? <p className="text-xs text-fg-muted">You recorded the call-back, so a different person must approve.</p> : null}
          {row.stage === 'awaiting_approval' && page.can.approve && !iCalled ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(approveBankChangeAction(row.id), 'Approved. The account will be used after the cool-off.')}>Approve</button> : null}
          {row.stage !== 'cooling_off' && page.can.approve ? <button type="button" className={dangerClass} disabled={busy} onClick={() => { setMode('reject'); setNote(''); }}>Refuse…</button> : null}
        </div>
      ) : (
        <form
          className="space-y-2 rounded-lg border border-line p-3"
          aria-label={mode === 'callback' ? 'Record the call-back' : 'Refuse the change'}
          onSubmit={(e) => { e.preventDefault(); void act(mode === 'callback' ? recordBankCallbackAction(row.id, note) : rejectBankChangeAction(row.id, note), mode === 'callback' ? 'The call-back is recorded.' : 'The change is refused.'); }}
        >
          <Field id={`${uid}-n`} label={mode === 'callback' ? 'Who you spoke to, on which number from our records, and what they confirmed' : 'Why the change is refused'}>
            <textarea id={`${uid}-n`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={fieldClass} required maxLength={1000} />
          </Field>
          <div className="flex gap-2"><button type="submit" className={mode === 'callback' ? primaryClass : dangerClass} disabled={busy}>{mode === 'callback' ? 'Save the call-back' : 'Refuse the change'}</button><button type="button" className={buttonClass} onClick={() => setMode(null)}>Cancel</button></div>
        </form>
      )}
    </article>
  );
}
