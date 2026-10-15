'use client';

import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  deleteJournalLineAction,
  postBatchAction,
  previewBatchAction,
  saveJournalLineAction,
  type BatchView,
} from '@/server/domains/finance/actions';
import {
  Chip,
  Field,
  Message,
  PageHeader,
  buttonClass,
  cardClass,
  dangerClass,
  fieldClass,
  isZeroAmount,
  money,
  primaryClass,
  today,
  type Notice, attempt } from './ui';

import { has } from '@/lib/has';

type Preview = Extract<Awaited<ReturnType<typeof previewBatchAction>>, { ok: true }>['data'];

export function JournalEditorClient({ view }: { view: BatchView }) {
  const uid = useId();
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editId, setEditId] = useState<string | undefined>();
  const [form, setForm] = useState({ postingDate: today(), documentNo: '', account: '', description: '', debit: '', credit: '' });

  const accountByText = useMemo(() => new Map(view.accounts.map((a) => [`${a.no} ${a.name}`, a])), [view.accounts]);

  // Debits and credits per document, so an out-of-balance document is visible before posting.
  const totals = useMemo(() => {
    const map = new Map<string, { d: number; c: number }>();
    for (const l of view.lines) {
      const t = map.get(l.documentNo) ?? { d: 0, c: 0 };
      t.d += Number(l.debit);
      t.c += Number(l.credit);
      map.set(l.documentNo, t);
    }
    return map;
  }, [view.lines]);

  const reset = () => {
    setEditId(undefined);
    setForm((f) => ({ ...f, account: '', description: '', debit: '', credit: '' }));
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const account = accountByText.get(form.account);
    if (!account) { setNotice({ kind: 'error', text: 'Pick an account from the list.' }); return; }
    setBusy(true);
    setPreview(null);
    const res = await attempt(saveJournalLineAction(
      view.batch.id,
      { postingDate: form.postingDate, documentNo: form.documentNo, accountId: account.id, description: form.description, debit: form.debit, credit: form.credit },
      editId,
    ));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice(null);
    reset();
    router.refresh();
  };

  const edit = (l: BatchView['lines'][number]) => {
    setEditId(l.id);
    setForm({
      postingDate: l.postingDate,
      documentNo: l.documentNo,
      account: `${l.accountNo} ${l.accountName}`,
      description: l.description ?? '',
      debit: isZeroAmount(l.debit) ? '' : l.debit.replace(/\.?0+$/, ''),
      credit: isZeroAmount(l.credit) ? '' : l.credit.replace(/\.?0+$/, ''),
    });
    document.getElementById(`${uid}-doc`)?.focus();
  };

  const remove = async (id: string) => {
    setBusy(true);
    setPreview(null);
    const res = await attempt(deleteJournalLineAction(view.batch.id, id));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    router.refresh();
  };

  const runPreview = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(previewBatchAction(view.batch.id));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setPreview(res.data);
    const bad = res.data.filter((p) => !p.ok).length;
    setNotice(bad === 0 ? { kind: 'ok', text: 'Everything in this batch can be posted.' } : { kind: 'error', text: `${bad} document${bad === 1 ? '' : 's'} cannot be posted yet.` });
  };

  const post = async () => {
    if (!window.confirm('Post this batch? Posted entries cannot be edited, only reversed.')) return;
    setBusy(true);
    setNotice(null);
    const res = await attempt(postBatchAction(view.batch.id));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    router.push('/admin/finance/registers');
  };

  const empty = view.lines.length === 0;

  return (
    <div className="max-w-6xl space-y-5">
      <p className="text-xs"><Link href="/admin/finance/journals" className="text-indigo-600 hover:underline">← All batches</Link></p>
      <PageHeader title={`${view.batch.code} · ${view.batch.name}`} intro={`Amounts are in ${view.baseCurrency}. Lines with the same document number post together and must balance.`} />
      <Message notice={notice} />

      {view.can.edit ? (
        <form onSubmit={save} className={`${cardClass} space-y-3`} aria-label={has(editId) ? 'Edit line' : 'Add line'}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Field id={`${uid}-date`} label="Posting date"><input id={`${uid}-date`} type="date" value={form.postingDate} onChange={(e) => setForm({ ...form, postingDate: e.target.value })} className={fieldClass} required /></Field>
            <Field id={`${uid}-doc`} label="Document no."><input id={`${uid}-doc`} value={form.documentNo} onChange={(e) => setForm({ ...form, documentNo: e.target.value })} className={`${fieldClass} font-mono`} required /></Field>
            <div className="lg:col-span-2">
              <Field id={`${uid}-acc`} label="Account">
                <input id={`${uid}-acc`} list={`${uid}-accounts`} value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} className={fieldClass} placeholder="Type a number or name" autoComplete="off" required />
                <datalist id={`${uid}-accounts`}>
                  {view.accounts.map((a) => <option key={a.id} value={`${a.no} ${a.name}`}>{a.control ? 'control account' : ''}</option>)}
                </datalist>
              </Field>
            </div>
            <Field id={`${uid}-debit`} label="Debit"><input id={`${uid}-debit`} inputMode="decimal" value={form.debit} onChange={(e) => setForm({ ...form, debit: e.target.value, credit: has(e.target.value) ? '' : form.credit })} className={`${fieldClass} text-right tabular-nums`} /></Field>
            <Field id={`${uid}-credit`} label="Credit"><input id={`${uid}-credit`} inputMode="decimal" value={form.credit} onChange={(e) => setForm({ ...form, credit: e.target.value, debit: has(e.target.value) ? '' : form.debit })} className={`${fieldClass} text-right tabular-nums`} /></Field>
            <div className="sm:col-span-2 lg:col-span-6">
              <Field id={`${uid}-desc`} label="Description"><input id={`${uid}-desc`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={fieldClass} /></Field>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>{has(editId) ? 'Save line' : 'Add line'}</button>
            {has(editId) ? <button type="button" className={buttonClass} onClick={reset}>Cancel edit</button> : null}
          </div>
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {view.can.preview ? <button type="button" className={buttonClass} onClick={runPreview} disabled={busy || empty}>Preview posting</button> : null}
        {view.can.post ? <button type="button" className={primaryClass} onClick={post} disabled={busy || empty}>Post batch</button> : null}
      </div>

      {empty ? (
        <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-fg-muted">No draft lines. Add the first line above.</div>
      ) : (
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
              {view.lines.map((l) => {
                const t = totals.get(l.documentNo)!;
                const balanced = Math.abs(t.d - t.c) < 0.00005;
                return (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-fg-muted">{l.postingDate}</td>
                    <td className="px-3 py-2"><span className="font-mono text-xs">{l.documentNo}</span> {balanced ? null : <Chip tone="amber">Out of balance</Chip>}</td>
                    <td className="px-3 py-2"><span className="font-mono text-xs">{l.accountNo}</span> {l.accountName}{has(l.description) ? <span className="block text-xs text-fg-muted">{l.description}</span> : null}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{isZeroAmount(l.debit) ? '' : money(l.debit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{isZeroAmount(l.credit) ? '' : money(l.credit)}</td>
                    <td className="px-3 py-2">
                      {view.can.edit ? (
                        <div className="flex justify-end gap-2">
                          <button type="button" className={buttonClass} onClick={() => edit(l)} disabled={busy} aria-label={`Edit line ${l.lineNo}`}>Edit</button>
                          <button type="button" className={dangerClass} onClick={() => remove(l.id)} disabled={busy} aria-label={`Delete line ${l.lineNo}`}>Delete</button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {preview ? (
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
                    <li key={l.line} className="flex justify-between gap-3"><span><span className="font-mono">{l.accountNo}</span> {l.accountName}</span><span className="tabular-nums">{money(l.debit) !== '0.00' ? `Dr ${money(l.debit)}` : `Cr ${money(l.credit)}`}</span></li>
                  ))}
                </ul>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-xs text-red-700" role="alert">
                  {p.issues.map((i, n) => <li key={n}>{i.line !== null && i.line !== undefined && i.line !== 0 ? `Line ${i.line}: ` : ''}{i.message}</li>)}
                </ul>
              )}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
