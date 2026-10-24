'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { archiveVendorAction, blockVendorAction, reinstateVendorAction, restoreVendorAction, suspendVendorAction } from '@/server/domains/vendors/admin-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { VENDOR_BLOCK } from '@/lib/vendor-forms';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, Message, attempt, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Result = { ok: true } | { ok: false; error: string };
type Mode = null | 'suspend' | 'block' | 'archive';

interface Props {
  vendorId: string;
  status: string;
  block: string;
  standing: { reasonCode: string | null; reasonText: string | null; since: string | null } | null;
  can: { suspend: boolean; block: boolean; archive: boolean };
}

const TITLES = { suspend: 'Suspend this vendor', block: 'Block this vendor', archive: 'Archive this vendor' } as const;
const EXPLAIN = {
  suspend: 'A suspended vendor keeps its login so it can see why, but nothing new is bought from it. You can reinstate it at any time.',
  block: 'Blocking stops payments, or every new document, without suspending the vendor. You can lift it at any time.',
  archive: 'Archiving takes the vendor out of use and ends its portal access. It is refused while the vendor is owed money or a bank change is waiting. History is kept, and you can restore it.',
} as const;

/** Suspend, block, archive and bring back: each with a reason, written to the vendor's history. */
export function VendorStandingPanel({ vendorId, status, block, standing, can }: Props) {
  const uid = useId();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [reason, setReason] = useState<Choice | null>(null);
  const [kind, setKind] = useState<Choice | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

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
    setReason(null);
    setKind(null);
    setText('');
    router.refresh();
  };
  const open = (m: Mode) => {
    setMode(m);
    setNotice(null);
    setReason(null);
    setKind(null);
    setText('');
  };
  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const why = { code: reason?.id ?? '', text };
    if (mode === 'suspend') void act(suspendVendorAction(vendorId, why), 'The vendor is suspended.');
    if (mode === 'archive') void act(archiveVendorAction(vendorId, why), 'The vendor is archived.');
    if (mode === 'block') void act(blockVendorAction(vendorId, kind?.id ?? '', why), 'The block is in place.');
  };

  const archived = status === 'archived';
  const live = status === 'active' || status === 'suspended';
  const needsComment = reason?.meta?.requiresComment === '1';
  const anything = (live && (can.suspend || can.block || can.archive)) || (archived && can.archive) || (block !== 'none' && can.block);
  if (!anything && block === 'none' && status !== 'suspended' && !archived) return null;

  return (
    <section aria-label="Standing" className={cardClass}>
      <h3 className="text-sm font-bold text-fg-strong">Standing</h3>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg">
        {archived ? <Chip tone="gray">Archived</Chip> : null}
        {status === 'suspended' ? <Chip tone="amber">Suspended</Chip> : null}
        {!archived && status !== 'suspended' ? <Chip tone="green">In good standing</Chip> : null}
        {block === 'none' ? null : <Chip tone="red">{VENDOR_BLOCK[block] ?? block}</Chip>}
        {standing?.reasonCode == null ? null : <span className="text-fg-muted">Reason: {standing.reasonCode.replace(/^VENDOR_/, '').replace(/_/g, ' ').toLowerCase()}{standing.reasonText === null ? '' : ` — ${standing.reasonText}`}</span>}
      </p>
      <Message notice={notice} />
      {mode === null ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {status === 'active' && can.suspend ? <button type="button" className={buttonClass} disabled={busy} onClick={() => open('suspend')}>Suspend…</button> : null}
          {status === 'suspended' && can.suspend ? <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(reinstateVendorAction(vendorId), 'The vendor is active again.')}>Reinstate</button> : null}
          {live && can.block ? <button type="button" className={buttonClass} disabled={busy} onClick={() => open('block')}>{block === 'none' ? 'Block…' : 'Change the block…'}</button> : null}
          {block !== 'none' && can.block ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(blockVendorAction(vendorId, 'none', { code: '', text: '' }), 'The block is lifted.')}>Lift the block</button> : null}
          {live && can.archive ? <button type="button" className={dangerClass} disabled={busy} onClick={() => open('archive')}>Archive…</button> : null}
          {archived && can.archive ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(restoreVendorAction(vendorId), 'The vendor is restored as suspended. Reinstate it when you have checked it.')}>Restore</button> : null}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border border-line p-3" aria-label={TITLES[mode]}>
          <p className="text-sm text-fg">{EXPLAIN[mode]}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {mode === 'block' ? <ChoicePicker label="Block" source="vendor-block-kinds" choice={kind} onChoice={setKind} clearable={false} required placeholder="Choose what to block…" /> : null}
            <ChoicePicker label="Reason" source="vendor-standing-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
            <Field id={`${uid}-t`} label={needsComment ? 'Explain (required)' : 'Comment (optional)'} hint="Kept with your name and the time.">
              <input id={`${uid}-t`} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} required={needsComment} maxLength={500} autoComplete="off" />
            </Field>
          </div>
          <div className="flex gap-2">
            <button type="submit" className={mode === 'archive' ? dangerClass : primaryClass} disabled={busy || reason === null || (mode === 'block' && kind === null)}>{TITLES[mode]}</button>
            <button type="button" className={buttonClass} onClick={() => setMode(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
