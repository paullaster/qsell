'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBatchAction } from '@/server/domains/finance/actions';
import { Field, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

export function JournalBatchesClient({
  batches,
  canCreate,
}: {
  batches: { id: string; code: string; name: string; lineCount: number }[];
  canCreate: boolean;
}) {
  const uid = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(createBatchAction(code, name));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    router.push(`/admin/finance/journals/${res.data.id}`);
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="General journals"
        intro="Prepare lines in a batch, preview exactly what would be posted, then post. Posted entries can never be edited: a mistake is corrected by reversing the posting."
        actions={canCreate ? <button type="button" className={primaryClass} onClick={() => setOpen((v) => !v)} aria-expanded={open}>New batch</button> : null}
      />
      <Message notice={notice} />
      {open ? (
        <form onSubmit={create} className={`${cardClass} grid grid-cols-1 gap-4 sm:grid-cols-3`} aria-label="New journal batch">
          <Field id={`${uid}-c`} label="Code"><input id={`${uid}-c`} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className={`${fieldClass} font-mono`} maxLength={20} required autoFocus /></Field>
          <Field id={`${uid}-n`} label="Name"><input id={`${uid}-n`} value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} required /></Field>
          <div className="flex items-end gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>Create</button>
            <button type="button" className={buttonClass} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : null}
      {batches.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-fg-muted">No batches yet.</div>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {batches.map((b) => (
            <li key={b.id}>
              <Link href={`/admin/finance/journals/${b.id}`} className="block rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500/40 hover:bg-hover">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-fg-strong"><span className="font-mono">{b.code}</span> <span className="font-normal text-fg-muted">{b.name}</span></p>
                  <span className="text-xs text-fg-muted">{b.lineCount} draft line{b.lineCount === 1 ? '' : 's'}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
