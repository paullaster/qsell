'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveDocumentTypeAction, type documentTypesAction } from '@/server/domains/vendors/admin-actions';
import { emptyDocumentType, type DocumentTypeForm } from '@/lib/vendor-document-types';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Rows = Extract<Awaited<ReturnType<typeof documentTypesAction>>, { ok: true }>['data'];
type Result = { ok: true } | { ok: false; error: string };

export function DocumentTypesClient({ initialPromise }: { initialPromise: ReturnType<typeof documentTypesAction> }) {
  const res = use(initialPromise);
  return res.ok ? <DocumentTypesView rows={res.data} /> : <LoadFailed error={res.error} />;
}

function Check({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex min-h-10 cursor-pointer items-start gap-2 text-sm text-fg">
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint === undefined ? null : <span className="block text-xs text-fg-muted">{hint}</span>}</span>
    </label>
  );
}

function DocumentTypesView({ rows }: { rows: Rows }) {
  const router = useRouter();
  const uid = useId();
  const [editing, setEditing] = useState<{ id: string | null; form: DocumentTypeForm } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const set = <K extends keyof DocumentTypeForm>(k: K, v: DocumentTypeForm[K]) => setEditing((e) => (e === null ? e : { ...e, form: { ...e.form, [k]: v } }));

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (editing === null) return;
    setBusy(true);
    setNotice(null);
    const res: Result = await attempt(saveDocumentTypeAction(editing.id, editing.form));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'Saved.' });
    setEditing(null);
    router.refresh();
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Vendor document types"
        intro="The documents vendors are asked for. A document marked required must be valid before a vendor can be approved. A type vendors already hold is switched off, never deleted."
        actions={<span className="flex items-center gap-3"><Link href="/admin/vendors" className="text-sm font-semibold text-indigo-600 hover:underline">All vendors</Link><button type="button" className={primaryClass} onClick={() => { setEditing({ id: null, form: emptyDocumentType() }); setNotice(null); }}>Add a document type</button></span>}
      />
      <Message notice={notice} />
      {editing === null ? null : (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-3`} aria-label={editing.id === null ? 'Add a document type' : 'Edit the document type'}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-c`} label="Code" hint={editing.id === null ? 'Capital letters, digits, dots, dashes and underscores. It cannot be changed later.' : 'The code cannot be changed.'}>
              <input id={`${uid}-c`} value={editing.form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} className={fieldClass} disabled={editing.id !== null} required maxLength={30} autoComplete="off" />
            </Field>
            <Field id={`${uid}-n`} label="Name"><input id={`${uid}-n`} value={editing.form.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} required maxLength={80} autoComplete="off" /></Field>
            <Field id={`${uid}-r`} label="Remind the vendor (days before it expires)" hint="For example 30, 7, 0. Leave empty for no reminders.">
              <input id={`${uid}-r`} value={editing.form.reminderDays} onChange={(e) => set('reminderDays', e.target.value)} className={fieldClass} disabled={!editing.form.needsExpiry} autoComplete="off" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            <Check id={`${uid}-req`} label="Required for every vendor" checked={editing.form.requiredForAll} onChange={(v) => set('requiredForAll', v)} />
            <Check id={`${uid}-exp`} label="Has an expiry date" checked={editing.form.needsExpiry} onChange={(v) => { set('needsExpiry', v); if (!v) set('blocking', false); }} />
            <Check id={`${uid}-blk`} label="Blocks the vendor when it expires" hint="Needs an expiry date." checked={editing.form.blocking} onChange={(v) => set('blocking', v)} />
            <Check id={`${uid}-act`} label="In use" checked={editing.form.isActive} onChange={(v) => set('isActive', v)} />
          </div>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className={buttonClass} onClick={() => setEditing(null)}>Cancel</button></div>
        </form>
      )}
      <ul className="space-y-2" aria-label="Document types">
        {rows.map((t) => (
          <li key={t.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2`}>
            <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{t.name}</span><span className="block text-xs text-fg-muted">{t.code}{t.needsExpiry ? ` · reminders at ${t.reminderDays === '' ? 'no set days' : t.reminderDays}` : ''}</span></span>
            <span className="flex flex-wrap items-center gap-2">
              {t.requiredForAll ? <Chip tone="sky">Required</Chip> : <Chip tone="gray">Optional</Chip>}
              {t.needsExpiry ? <Chip tone="gray">Expires</Chip> : null}
              {t.blocking ? <Chip tone="amber">Blocks when expired</Chip> : null}
              {t.isActive ? null : <Chip tone="red">Not in use</Chip>}
              <button type="button" className={buttonClass} onClick={() => { setEditing({ id: t.id, form: { code: t.code, name: t.name, requiredForAll: t.requiredForAll, needsExpiry: t.needsExpiry, reminderDays: t.reminderDays, blocking: t.blocking, isActive: t.isActive } }); setNotice(null); }} aria-label={`Edit ${t.name}`}>Edit</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
