'use client';

import Link from 'next/link';
import { use, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteJournalLineAction, type getBatchAction, postBatchAction, previewBatchAction, saveJournalLineAction } from '@/server/domains/finance/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { blankLine, documentTotals, isBalanced, lineForm, lineProblem, withAmount, type JournalForm } from '@/lib/ledger-forms';
import { withKeys } from '@/lib/statement-import-form';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, isZeroAmount, money, primaryClass, today, type Notice, attempt } from './ui';

type Preview = Extract<Awaited<ReturnType<typeof previewBatchAction>>, { ok: true }>['data'];
type BatchView = Extract<Awaited<ReturnType<typeof getBatchAction>>, { ok: true }>['data'];

export function JournalEditorClient({ viewPromise }: { viewPromise: ReturnType<typeof getBatchAction> }) {
  const res = use(viewPromise);
  return res.ok ? <JournalEditorView view={res.data} /> : <LoadFailed error={res.error} />;
}

function JournalEditorView({ view }: { view: BatchView }) {
  const uid = useId();
  const router = useRouter();
  const docField = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editId, setEditId] = useState<string | undefined>();
  const [form, setForm] = useState<JournalForm>(() => blankLine(today()));
  const [confirmPost, setConfirmPost] = useState(false);

  const totals = documentTotals(view.lines);
  const reset = () => {
    setEditId(undefined);
    setForm((f) => ({ ...blankLine(f.postingDate), documentNo: f.documentNo }));
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = lineProblem(form);
    if (problem !== null || form.account === null) {
      setNotice({ kind: 'error', text: problem ?? 'Pick an account from the list.' });
      return;
    }
    setBusy(true);
    setPreview(null);
    const res = await attempt(saveJournalLineAction(view.batch.id, { postingDate: form.postingDate, documentNo: form.documentNo, accountId: form.account.id, description: form.description, debit: form.debit, credit: form.credit }, editId));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice(null);
    reset();
    router.refresh();
  };

  const edit = (l: BatchView['lines'][number]) => {
    setEditId(l.id);
    setForm(lineForm(l));
    docField.current?.focus();
  };

  const remove = async (id: string) => {
    setBusy(true);
    setPreview(null);
    const res = await attempt(deleteJournalLineAction(view.batch.id, id));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.refresh();
  };

  const runPreview = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(previewBatchAction(view.batch.id));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setPreview(res.data);
    const bad = res.data.filter((p) => !p.ok).length;
    setNotice(bad === 0 ? { kind: 'ok', text: 'Everything in this batch can be posted.' } : { kind: 'error', text: `${String(bad)} ${bad === 1 ? 'document' : 'documents'} cannot be posted yet.` });
  };

  const post = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(postBatchAction(view.batch.id));
    setBusy(false);
    setConfirmPost(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    router.push('/admin/finance/registers');
  };

  const empty = view.lines.length === 0;
  const editing = editId !== undefined;

  return (
    <div className="max-w-6xl space-y-5">
      <p className="text-xs"><Link href="/admin/finance/journals" className="text-indigo-600 hover:underline">← All batches</Link></p>
      <PageHeader title={`${view.batch.code} · ${view.batch.name}`} intro={`Amounts are in ${view.baseCurrency}. Lines with the same document number post together and must balance.`} />
      <Message notice={notice} />

      {view.can.edit ? (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-3`} aria-label={editing ? 'Edit line' : 'Add line'}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Field id={`${uid}-date`} label="Posting date"><input id={`${uid}-date`} type="date" value={form.postingDate} onChange={(e) => setForm({ ...form, postingDate: e.target.value })} className={fieldClass} required /></Field>
            <Field id={`${uid}-doc`} label="Document no."><input ref={docField} id={`${uid}-doc`} value={form.documentNo} onChange={(e) => setForm({ ...form, documentNo: e.target.value })} className={`${fieldClass} font-mono`} required autoComplete="off" /></Field>
            <div className="lg:col-span-2"><ChoicePicker label="Account" source="journal-accounts" choice={form.account} onChoice={(account) => setForm({ ...form, account })} clearable={false} required placeholder="Type a number or name" /></div>
            <Field id={`${uid}-debit`} label="Debit"><input id={`${uid}-debit`} inputMode="decimal" value={form.debit} onChange={(e) => setForm(withAmount(form, 'debit', e.target.value))} className={`${fieldClass} text-right tabular-nums`} autoComplete="off" /></Field>
            <Field id={`${uid}-credit`} label="Credit"><input id={`${uid}-credit`} inputMode="decimal" value={form.credit} onChange={(e) => setForm(withAmount(form, 'credit', e.target.value))} className={`${fieldClass} text-right tabular-nums`} autoComplete="off" /></Field>
            <div className="sm:col-span-2 lg:col-span-6">
              <Field id={`${uid}-desc`} label="Description"><input id={`${uid}-desc`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={fieldClass} autoComplete="off" /></Field>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>{editing ? 'Save line' : 'Add line'}</button>
            {editing ? <button type="button" className={buttonClass} onClick={reset}>Cancel edit</button> : null}
          </div>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {view.can.preview ? <button type="button" className={buttonClass} onClick={() => void runPreview()} disabled={busy || empty}>Preview posting</button> : null}
        {view.can.post && !confirmPost ? <button type="button" className={primaryClass} onClick={() => setConfirmPost(true)} disabled={busy || empty}>Post batch</button> : null}
        {view.can.post && confirmPost ? (
          <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm posting">
            <span className="text-sm text-fg">Post this batch? Posted entries cannot be edited, only reversed.</span>
            <button type="button" className={primaryClass} onClick={() => void post()} disabled={busy}>Yes, post it</button>
            <button type="button" className={buttonClass} onClick={() => setConfirmPost(false)}>Not yet</button>
          </span>
        ) : null}
      </div>

      {empty ? <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-fg-muted">No draft lines. Add the first line above.</div> : null}
      {empty ? null : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">Draft journal lines</caption>
            <thead className="bg-surface-sunken text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">Date</th>
                <th scope="col" className="px-3 py-2 font-semibold">Document</th>
                <th scope="col" className="px-3 py-2 font-semibold">Account</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Debit</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Credit</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {view.lines.map((l) => (
                <tr key={l.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-fg-muted">{l.postingDate}</td>
                  <td className="px-3 py-2"><span className="font-mono text-xs">{l.documentNo}</span> {isBalanced(totals, l.documentNo) ? null : <Chip tone="amber">Out of balance</Chip>}</td>
                  <td className="px-3 py-2"><span className="font-mono text-xs">{l.accountNo}</span> {l.accountName}{l.description === null || l.description === '' ? null : <span className="block text-xs text-fg-muted">{l.description}</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{isZeroAmount(l.debit) ? '' : money(l.debit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{isZeroAmount(l.credit) ? '' : money(l.credit)}</td>
                  <td className="px-3 py-2">
                    {view.can.edit ? (
                      <div className="flex justify-end gap-2">
                        <button type="button" className={buttonClass} onClick={() => edit(l)} disabled={busy} aria-label={`Edit line ${String(l.lineNo)}`}>Edit</button>
                        <button type="button" className={dangerClass} onClick={() => void remove(l.id)} disabled={busy} aria-label={`Delete line ${String(l.lineNo)}`}>Delete</button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview === null ? null : (
        <section aria-label="Posting preview" className="space-y-3">
          <h3 className="text-sm font-bold text-fg-strong">What would be posted</h3>
          {preview.map((p) => (
            <div key={`${p.documentNo}|${p.postingDate}|${p.currency}`} className={`${cardClass} space-y-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-fg-strong"><span className="font-mono">{p.documentNo}</span> · {p.postingDate}</p>
                {p.ok ? <Chip tone="green">Can be posted</Chip> : <Chip tone="red">Cannot be posted</Chip>}
              </div>
              {p.ok ? (
                <ul className="space-y-1 text-xs">
                  {p.lines.map((l) => (
                    <li key={l.line} className="flex justify-between gap-3"><span><span className="font-mono">{l.accountNo}</span> {l.accountName}</span><span className="tabular-nums">{isZeroAmount(l.debit) ? `Cr ${money(l.credit)}` : `Dr ${money(l.debit)}`}</span></li>
                  ))}
                </ul>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-xs text-red-700" role="alert">
                  {withKeys(p.issues, 'issue').map(({ key, item }) => <li key={key}>{item.line === undefined ? '' : `Line ${String(item.line)}: `}{item.message}</li>)}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
