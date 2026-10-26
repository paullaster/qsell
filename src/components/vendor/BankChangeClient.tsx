'use client';

import Link from 'next/link';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { proposeBankChangeAction, withdrawBankChangeAction, type bankStatusAction } from '@/server/domains/vendors/portal-team-actions';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { DESTINATION_KINDS, numberLabel, maskAccount } from '@/lib/vendor-profile';
import { Chip, Field, LoadFailed, Message, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Status = Extract<Awaited<ReturnType<typeof bankStatusAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string; problems?: Record<string, string> };

const STAGE_WORDS = {
  awaiting_callback: 'We will phone you on the number we hold to confirm it.',
  awaiting_approval: 'Confirmed by phone. A second person at our side must approve it.',
  cooling_off: 'Approved. It will be used after a short waiting period.',
} as const;

const blank = { bankName: '', branch: '', accountName: '', accountNumber: '', swift: '', kind: 'bank', reference: '', replacesId: '', evidenceDocumentId: '' };

/** For an approved vendor: where it is paid now, any change waiting, and the request to change it. */
export function BankChangeClient({ statusPromise }: { statusPromise: ReturnType<typeof bankStatusAction> }) {
  const res = use(statusPromise);
  return res.ok ? <BankChangeView status={res.data} /> : <LoadFailed error={res.error} />;
}

function BankChangeView({ status }: { status: Status }) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState(blank);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const set = (k: keyof typeof blank, v: string) => setForm((p) => ({ ...p, [k]: v }));

  if (!status.active) return null;

  const act = async (call: Promise<Result>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    setProblems({});
    const res = await attempt(call);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      setProblems('problems' in res && res.problems !== undefined ? res.problems : {});
      return false;
    }
    setNotice({ kind: 'ok', text: done });
    router.refresh();
    return true;
  };
  const p = (k: string) => problems[k] ?? problems[`banks.0.${k}`];

  return (
    <section className={`${cardClass} space-y-3`} aria-label="Change where you are paid">
      <h3 className="text-sm font-bold text-fg-strong">Where you are paid</h3>
      <Message notice={notice} />
      <ul className="divide-y divide-line text-sm">
        {status.accounts.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span><span className="font-semibold text-fg-strong">{a.bankName}, {a.branch}</span> <span className="text-fg-muted">{a.accountName} {maskAccount(a.last4)}</span></span>
            <Chip tone="green">In use</Chip>
          </li>
        ))}
        {status.pending.map((c) => (
          <li key={c.id} className="space-y-1 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><span className="font-semibold text-fg-strong">{c.bankName}, {c.branch}</span> <span className="text-fg-muted">{c.accountName} {maskAccount(c.last4)}</span></span>
              <span className="flex items-center gap-2"><Chip tone="amber">Waiting</Chip>
                {c.stage === 'cooling_off' ? null : <InlineConfirm label={`Withdraw the request for the ${c.bankName} account`} action="Withdraw" confirm="Yes, withdraw" busy={busy} onConfirm={() => void act(withdrawBankChangeAction(c.id), 'The request is withdrawn.')} />}
              </span>
            </div>
            <p className="text-xs text-fg-muted">{STAGE_WORDS[c.stage]}{c.effectiveFrom === null ? '' : ` In use from ${new Date(c.effectiveFrom).toLocaleDateString()}.`}</p>
          </li>
        ))}
      </ul>
      {status.canPropose && status.pending.length === 0 && !open ? <button type="button" className={buttonClass} onClick={() => setOpen(true)}>Change my bank details…</button> : null}
      {status.canPropose && status.pending.length === 0 && open ? (
        <form noValidate aria-label="Request a change of bank details" className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); void act(proposeBankChangeAction(form), 'Your request was sent. We will phone you to confirm it.').then((ok) => { if (ok) { setForm(blank); setOpen(false); } }); }}>
            <p className="text-sm text-fg">To protect you from fraud, a change is never used straight away: we phone you on the number we already hold, a second person approves, and the new account starts after a short waiting period. Payments keep going to your current account until then.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ChoicePicker label="Where we pay" source="vendor-destination-kinds" choice={DESTINATION_KINDS.find((k) => k.id === form.kind) ?? null} onChoice={(c) => set('kind', c?.id ?? 'bank')} clearable={false} />
              {form.kind === 'bank' ? <Field id={`${uid}-bn`} label="Bank" hint={p('bankName')}><input id={`${uid}-bn`} value={form.bankName} onChange={(e) => set('bankName', e.target.value)} className={fieldClass} required autoComplete="off" /></Field> : null}
              {form.kind === 'bank' ? <Field id={`${uid}-bb`} label="Branch" hint={p('branch')}><input id={`${uid}-bb`} value={form.branch} onChange={(e) => set('branch', e.target.value)} className={fieldClass} required autoComplete="off" /></Field> : null}
              <Field id={`${uid}-ba`} label={form.kind === 'bank' ? 'Account name' : 'Name registered with M-Pesa'} hint={p('accountName')}><input id={`${uid}-ba`} value={form.accountName} onChange={(e) => set('accountName', e.target.value)} className={fieldClass} required autoComplete="off" /></Field>
              <Field id={`${uid}-bu`} label={numberLabel(form.kind)} hint={p('accountNumber') ?? 'Kept sealed. Only the last four digits are shown afterwards.'}><input id={`${uid}-bu`} value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} className={fieldClass} required autoComplete="off" inputMode="numeric" /></Field>
              {form.kind === 'mpesa_paybill' || form.kind === 'mpesa_till' ? <Field id={`${uid}-br`} label={form.kind === 'mpesa_paybill' ? 'Account number to quote' : 'Reference (optional)'} hint={p('reference')}><input id={`${uid}-br`} value={form.reference} onChange={(e) => set('reference', e.target.value)} className={fieldClass} autoComplete="off" /></Field> : null}
              {form.kind === 'bank' ? <Field id={`${uid}-bs`} label="SWIFT code (foreign banks)" hint={p('swift')}><input id={`${uid}-bs`} value={form.swift} onChange={(e) => set('swift', e.target.value)} className={fieldClass} autoComplete="off" /></Field> : null}
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-semibold text-fg-strong">What does this account do?</legend>
              {status.accounts.map((a) => (
                <label key={a.id} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg"><input type="radio" className="h-5 w-5" name={`${uid}-r`} checked={form.replacesId === a.id} onChange={() => set('replacesId', a.id)} />Replaces {a.bankName} {maskAccount(a.last4)}</label>
              ))}
              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg"><input type="radio" className="h-5 w-5" name={`${uid}-r`} checked={form.replacesId === ''} onChange={() => set('replacesId', '')} />Is an additional account</label>
            </fieldset>
            <fieldset className="space-y-1">
              <legend className="text-sm font-semibold text-fg-strong">Bank letter for the new account</legend>
              {status.bankLetters.length === 0 ? <p className="text-sm text-fg-muted">Upload a bank confirmation letter first, on the <Link href="/vendor/profile/attachments" className="font-semibold text-indigo-600 hover:underline">attachments page</Link>, then come back.</p> : status.bankLetters.map((d) => (
                <label key={d.id} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg"><input type="radio" className="h-5 w-5" name={`${uid}-e`} checked={form.evidenceDocumentId === d.id} onChange={() => set('evidenceDocumentId', d.id)} />{d.fileName}</label>
              ))}
              {p('evidenceDocumentId') === undefined ? null : <p role="alert" className="text-sm text-red-600">{p('evidenceDocumentId')}</p>}
            </fieldset>
            <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy || form.evidenceDocumentId === ''}>{busy ? 'Sending…' : 'Send the request'}</button><button type="button" className={buttonClass} onClick={() => setOpen(false)}>Cancel</button></div>
          </form>
      ) : null}
      {status.canPropose ? null : <p className="text-xs text-fg-muted">Only the owner or the finance person can change bank details.</p>}
    </section>
  );
}
