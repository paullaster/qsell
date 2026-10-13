'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { savedStatementFormatAction } from '@/server/domains/finance/bank-statement-actions';
import type { CsvMapping } from '@/server/domains/finance/domain/bank-statement';
import { Field, Message, buttonClass, cardClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

type Inspect = { headers: string[]; sample: string[][]; suggested: CsvMapping | null; mt940: boolean };
type Preview = {
  errors: { row: number; message: string }[];
  errorCount: number;
  lineCount: number;
  newCount: number;
  duplicateCount: number;
  skippedCount: number;
  totalIn: string;
  totalOut: string;
  dateFrom: string | null;
  dateTo: string | null;
  opening: string | null;
  closing: string | null;
  balanceBreaks: number[];
  first: { date: string; description: string; reference: string | null; amount: string }[];
};
type Reply<T> = { ok: true; data: T & { kind: string } } | { ok: false; error: string };

const blank: CsvMapping = { headerRow: 1, date: '', dateFormat: 'auto', description: [] };

async function send<T>(mode: string, file: File, bankAccountId: string, extra: Record<string, string>): Promise<Reply<T>> {
  const body = new FormData();
  body.set('file', file);
  body.set('mode', mode);
  body.set('bankAccountId', bankAccountId);
  for (const [k, v] of Object.entries(extra)) body.set(k, v);
  try {
    const res = await fetch('/api/admin/finance/bank-statement-import', { method: 'POST', body });
    return (await res.json()) as Reply<T>;
  } catch {
    return { ok: false, error: 'The file could not be sent. Check your connection and try again.' };
  }
}

/** Choose a file, say which column is which (remembered for next time), check it, import it. */
export function StatementImportPanel({ bankAccountId, onClose }: { bankAccountId: string; onClose: () => void }) {
  const uid = useId();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [format, setFormat] = useState<'csv' | 'mt940'>('csv');
  const [map, setMap] = useState<CsvMapping>(blank);
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('split');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const choose = async (f: File) => {
    setBusy(true);
    setNotice(null);
    setPreview(null);
    setFile(f);
    const [saved, res] = await Promise.all([attempt(savedStatementFormatAction(bankAccountId)), send<Inspect>('inspect', f, bankAccountId, { headerRow: '1' })]);
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setInfo(res.data);
    if (res.data.mt940) {
      setFormat('mt940');
      return;
    }
    setFormat('csv');
    const fromSaved = saved.ok && saved.data && saved.data.kind === 'csv' ? saved.data.mapping : null;
    const m = fromSaved && fromSaved.date && res.data.headers.includes(fromSaved.date) ? fromSaved : (res.data.suggested ?? blank);
    setMap(m);
    setAmountMode(m.amount ? 'single' : 'split');
  };

  const mapping = (): CsvMapping => ({ ...map, description: map.description.filter(Boolean), ...(amountMode === 'single' ? { paidIn: undefined, withdrawn: undefined } : { amount: undefined }) });
  const fields = () => ({ format, mapping: JSON.stringify(mapping()), headerRow: String(map.headerRow), saveFormat: save ? '1' : '0' });

  const check = async () => {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    const res = await send<Preview>('preview', file, bankAccountId, fields());
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setPreview(res.data);
  };
  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    const res = await send<{ lines: number; duplicates: number; autoMatched: number; proposed: number; balanceBreaks: number }>('import', file, bankAccountId, fields());
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: `Imported ${res.data.lines} line${res.data.lines === 1 ? '' : 's'}${res.data.duplicates ? ` (${res.data.duplicates} already there)` : ''}. ${res.data.autoMatched} matched by themselves, ${res.data.proposed} suggested.` });
    setFile(null);
    setInfo(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = '';
    router.refresh();
  };

  const col = (id: string, label: string, value: string | undefined, set: (v: string) => void, optional = false) => (
    <Field id={`${uid}-${id}`} label={label}>
      <select id={`${uid}-${id}`} value={value ?? ''} onChange={(e) => { set(e.target.value); setPreview(null); }} className={fieldClass} required={!optional}>
        <option value="">{optional ? 'None' : 'Choose…'}</option>
        {info?.headers.filter(Boolean).map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </Field>
  );
  const ready = format === 'mt940' || (map.date && map.description.length > 0 && (amountMode === 'single' ? map.amount : map.paidIn || map.withdrawn));

  return (
    <section className={`${cardClass} space-y-4`} aria-label="Import a bank statement">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-bold text-fg-strong">Import a bank statement</h2>
        <button type="button" className={buttonClass} onClick={onClose}>Close</button>
      </div>
      <Message notice={notice} />
      <div>
        <label htmlFor={`${uid}-file`} className="text-xs font-semibold text-fg-muted">Statement file (CSV saved from Excel, an M-Pesa export, or MT940; up to 10 MB)</label>
        <input id={`${uid}-file`} ref={fileRef} type="file" accept=".csv,.txt,.sta,.mt940,text/csv,text/plain" disabled={busy} className="mt-1 block min-h-10 text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }} />
      </div>

      {info && format === 'csv' ? (
        <fieldset className="space-y-3" disabled={busy}>
          <legend className="text-xs font-bold uppercase text-fg-muted">Which column is which</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {col('date', 'Date', map.date, (v) => setMap({ ...map, date: v }))}
            <Field id={`${uid}-df`} label="Dates are written">
              <select id={`${uid}-df`} value={map.dateFormat ?? 'auto'} onChange={(e) => { setMap({ ...map, dateFormat: e.target.value as CsvMapping['dateFormat'] }); setPreview(null); }} className={fieldClass}>
                <option value="auto">Day first (13/10/2026) or 2026-10-13</option>
                <option value="mdy">Month first (10/13/2026)</option>
              </select>
            </Field>
            {col('d1', 'Description', map.description[0], (v) => setMap({ ...map, description: [v, ...map.description.slice(1)] }))}
            {col('d2', 'More description', map.description[1], (v) => setMap({ ...map, description: [map.description[0] ?? '', v].filter(Boolean) }), true)}
            {col('ref', 'Reference or receipt number', map.reference, (v) => setMap({ ...map, reference: v || undefined }), true)}
            {col('bal', 'Running balance', map.balance, (v) => setMap({ ...map, balance: v || undefined }), true)}
          </div>
          <div role="radiogroup" aria-label="How the amount is given" className="flex flex-wrap gap-4 text-sm">
            <label className="flex min-h-10 items-center gap-2"><input type="radio" name={`${uid}-am`} checked={amountMode === 'split'} onChange={() => { setAmountMode('split'); setPreview(null); }} /> Separate money-in and money-out columns</label>
            <label className="flex min-h-10 items-center gap-2"><input type="radio" name={`${uid}-am`} checked={amountMode === 'single'} onChange={() => { setAmountMode('single'); setPreview(null); }} /> One signed amount column</label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {amountMode === 'single' ? col('amt', 'Amount', map.amount, (v) => setMap({ ...map, amount: v })) : (
              <>
                {col('in', 'Money in (credit)', map.paidIn, (v) => setMap({ ...map, paidIn: v || undefined }), true)}
                {col('out', 'Money out (debit)', map.withdrawn, (v) => setMap({ ...map, withdrawn: v || undefined }), true)}
              </>
            )}
          </div>
          {info.sample.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-xs"><caption className="sr-only">First rows of the file</caption>
                <thead><tr>{info.headers.map((h, i) => <th key={`${h}-${i}`} scope="col" className="whitespace-nowrap px-2 py-1 text-left font-semibold text-fg-muted">{h}</th>)}</tr></thead>
                <tbody>{info.sample.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="whitespace-nowrap px-2 py-1">{c}</td>)}</tr>)}</tbody>
              </table>
            </div>
          ) : null}
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Remember these columns for this account</label>
        </fieldset>
      ) : null}
      {info && format === 'mt940' ? <p className="text-sm text-fg-muted">This is an MT940 file: no columns to choose.</p> : null}

      {info ? <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy || !ready} onClick={() => void check()}>Check the file</button></div> : null}

      {preview ? (
        <div className="space-y-2 rounded-lg border border-line p-3 text-sm" role="status" aria-live="polite">
          {preview.errorCount > 0 ? (
            <div role="alert" className="space-y-1 text-red-700">
              <p className="font-bold">The file cannot be imported yet ({preview.errorCount} problem{preview.errorCount === 1 ? '' : 's'}):</p>
              <ul className="list-disc pl-5 text-xs">{preview.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
            </div>
          ) : (
            <>
              <p><b>{preview.newCount}</b> new line{preview.newCount === 1 ? '' : 's'} from {preview.dateFrom} to {preview.dateTo}. Money in {money(preview.totalIn)}, money out {money(preview.totalOut)}.</p>
              {preview.duplicateCount > 0 ? <p className="text-xs text-fg-muted">{preview.duplicateCount} line{preview.duplicateCount === 1 ? '' : 's'} already imported before will be left out.</p> : null}
              {preview.opening !== null && preview.closing !== null ? <p className="text-xs text-fg-muted">The bank&apos;s balance goes from {money(preview.opening)} to {money(preview.closing)}.</p> : null}
              {preview.balanceBreaks.length > 0 ? <p role="alert" className="text-xs font-semibold text-amber-700">The running balance does not follow from the amounts at {preview.balanceBreaks.length} row{preview.balanceBreaks.length === 1 ? '' : 's'} (first: line {preview.balanceBreaks[0]}). Check that the right columns are chosen.</p> : null}
              <ul className="space-y-1 text-xs">{preview.first.map((l, i) => <li key={i}>{l.date} · {l.description || l.reference} · <b className={Number(l.amount) < 0 ? 'text-red-700' : 'text-green-700'}>{money(l.amount)}</b></li>)}</ul>
              <button type="button" className={primaryClass} disabled={busy || preview.newCount === 0} onClick={() => void doImport()}>Import {preview.newCount} line{preview.newCount === 1 ? '' : 's'}</button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
