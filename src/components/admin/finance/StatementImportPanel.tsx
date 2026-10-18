'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { savedStatementFormatAction, searchStatementColumnsAction } from '@/server/domains/finance/bank-statement-actions';
import { Autocomplete } from '@/components/ui/autocomplete/Autocomplete';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { BLANK_MAPPING, DATE_FORMATS, importFields, isFileFormat, importedMessage, lineLabel, mappingReady, startingAmountMode, startingMapping, withDescription, withKeys, type AmountMode, type CsvMapping, type FileFormat } from '@/lib/statement-import-form';
import { Message, buttonClass, cardClass, money, primaryClass, type Notice, attempt } from './ui';

interface Inspect { headers: string[]; sample: string[][]; suggested: CsvMapping | null; fixed: boolean; fileFormat: string; source: string }
interface Preview {
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
}
const NO_HEADERS: string[] = [];
type Reply<T> = { ok: true; data: T & { kind: string } } | { ok: false; error: string };

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
  const [format, setFormat] = useState<FileFormat>('csv');
  const [map, setMap] = useState<CsvMapping>(BLANK_MAPPING);
  const [amountMode, setAmountMode] = useState<AmountMode>('split');
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
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setInfo(res.data);
    if (res.data.fixed && isFileFormat(res.data.fileFormat)) {
      setFormat(res.data.fileFormat);
      return;
    }
    setFormat('csv');
    const fromSaved = saved.ok && saved.data?.kind === 'csv' ? (saved.data.mapping as CsvMapping) : null;
    const m = startingMapping(fromSaved, res.data.suggested, res.data.headers);
    setMap(m);
    setAmountMode(startingAmountMode(m));
  };

  const fields = () => importFields(format, map, amountMode, save);

  const check = async () => {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    const res = await send<Preview>('preview', file, bankAccountId, fields());
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setPreview(res.data);
  };
  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    const res = await send<{ lines: number; duplicates: number; autoMatched: number; proposed: number; balanceBreaks: number }>('import', file, bankAccountId, fields());
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: importedMessage(res.data) });
    setFile(null);
    setInfo(null);
    setPreview(null);
    if (fileRef.current !== null) fileRef.current.value = '';
    router.refresh();
  };

  const headers = info?.headers ?? NO_HEADERS;
  const loadColumns = useCallback(
    async ({ query, cursor, limit }: { query: string; cursor: string | null; limit: number }) => {
      const res = await searchStatementColumnsAction({ headers, query, cursor, limit });
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    [headers],
  );
  const col = (label: string, value: string | undefined, set: (v: string) => void, optional = false) => (
    <Autocomplete
      label={label}
      value={value === undefined || value === '' ? null : value}
      valueLabel={value === undefined || value === '' ? null : value}
      onChange={(o) => { set(o?.id ?? ''); setPreview(null); }}
      loadOptions={loadColumns}
      placeholder={optional ? 'None' : 'Choose…'}
      required={!optional}
      clearable={optional}
    />
  );
  const ready = mappingReady(format, map, amountMode);

  return (
    <section className={`${cardClass} space-y-4`} aria-label="Import a bank statement">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-bold text-fg-strong">Import a bank statement</h2>
        <button type="button" className={buttonClass} onClick={onClose}>Close</button>
      </div>
      <Message notice={notice} />
      <div>
        <label htmlFor={`${uid}-file`} className="text-xs font-semibold text-fg-muted">Statement file (Excel, CSV, an M-Pesa export, MT940 or camt.053 XML; up to 10 MB)</label>
        <input id={`${uid}-file`} ref={fileRef} type="file" accept=".csv,.txt,.sta,.mt940,.xml,.xlsx,text/csv,text/plain,text/xml,application/xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} className="mt-1 block min-h-10 text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }} />
      </div>

      {info !== null && format === 'csv' ? (
        <fieldset className="space-y-3" disabled={busy}>
          <legend className="text-xs font-bold uppercase text-fg-muted">Which column is which</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {col('Date', map.date, (v) => setMap({ ...map, date: v }))}
            <ChoicePicker label="Dates are written" source="statement-date-formats" choice={{ id: map.dateFormat ?? 'auto', label: DATE_FORMATS.find((d) => d.id === (map.dateFormat ?? 'auto'))?.label ?? '' }} onChoice={(c) => { setMap({ ...map, dateFormat: (c?.id ?? 'auto') as CsvMapping['dateFormat'] }); setPreview(null); }} clearable={false} required />
            {col('Description', map.description.at(0), (v) => setMap(withDescription(map, 0, v)))}
            {col('More description', map.description.at(1), (v) => setMap(withDescription(map, 1, v)), true)}
            {col('Reference or receipt number', map.reference, (v) => setMap({ ...map, reference: v === '' ? undefined : v }), true)}
            {col('Running balance', map.balance, (v) => setMap({ ...map, balance: v === '' ? undefined : v }), true)}
          </div>
          <div role="radiogroup" aria-label="How the amount is given" className="flex flex-wrap gap-4 text-sm">
            <label className="flex min-h-10 items-center gap-2"><input type="radio" name={`${uid}-am`} checked={amountMode === 'split'} onChange={() => { setAmountMode('split'); setPreview(null); }} /> Separate money-in and money-out columns</label>
            <label className="flex min-h-10 items-center gap-2"><input type="radio" name={`${uid}-am`} checked={amountMode === 'single'} onChange={() => { setAmountMode('single'); setPreview(null); }} /> One signed amount column</label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {amountMode === 'single' ? col('Amount', map.amount, (v) => setMap({ ...map, amount: v === '' ? undefined : v })) : (
              <>
                {col('Money in (credit)', map.paidIn, (v) => setMap({ ...map, paidIn: v === '' ? undefined : v }), true)}
                {col('Money out (debit)', map.withdrawn, (v) => setMap({ ...map, withdrawn: v === '' ? undefined : v }), true)}
              </>
            )}
          </div>
          {info.sample.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-xs"><caption className="sr-only">First rows of the file</caption>
                <thead><tr>{withKeys(info.headers, 'h').map(({ key, item }) => <th key={key} scope="col" className="whitespace-nowrap px-2 py-1 text-left font-semibold text-fg-muted">{item}</th>)}</tr></thead>
                <tbody>{withKeys(info.sample, 'r').map(({ key, item }) => <tr key={key}>{withKeys(item, key).map((cell) => <td key={cell.key} className="whitespace-nowrap px-2 py-1">{cell.item}</td>)}</tr>)}</tbody>
              </table>
            </div>
          ) : null}
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Remember these columns for this account</label>
        </fieldset>
      ) : null}
      {info !== null && format !== 'csv' ? <p className="text-sm text-fg-muted">This is {info.source}: no columns to choose.</p> : null}
      {info !== null && format === 'csv' && info.source.startsWith('an Excel') ? <p className="text-sm text-fg-muted">This is {info.source}. Choose the columns below as for a CSV.</p> : null}

      {info === null ? null : <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy || !ready} onClick={() => void check()}>Check the file</button></div>}

      {preview === null ? null : (
        <div className="space-y-2 rounded-lg border border-line p-3 text-sm" role="status" aria-live="polite">
          {preview.errorCount > 0 ? (
            <div role="alert" className="space-y-1 text-red-700">
              <p className="font-bold">The file cannot be imported yet ({preview.errorCount} problem{preview.errorCount === 1 ? '' : 's'}):</p>
              <ul className="list-disc pl-5 text-xs">{withKeys(preview.errors, 'e').map(({ key, item }) => <li key={key}>{item.message}</li>)}</ul>
            </div>
          ) : (
            <>
              <p><b>{preview.newCount}</b> new line{preview.newCount === 1 ? '' : 's'} from {preview.dateFrom} to {preview.dateTo}. Money in {money(preview.totalIn)}, money out {money(preview.totalOut)}.</p>
              {preview.duplicateCount > 0 ? <p className="text-xs text-fg-muted">{preview.duplicateCount} line{preview.duplicateCount === 1 ? '' : 's'} already imported before will be left out.</p> : null}
              {preview.opening !== null && preview.closing !== null ? <p className="text-xs text-fg-muted">The bank&apos;s balance goes from {money(preview.opening)} to {money(preview.closing)}.</p> : null}
              {preview.balanceBreaks.length > 0 ? <p role="alert" className="text-xs font-semibold text-amber-700">The running balance does not follow from the amounts at {preview.balanceBreaks.length} row{preview.balanceBreaks.length === 1 ? '' : 's'} (first: line {preview.balanceBreaks[0]}). Check that the right columns are chosen.</p> : null}
              <ul className="space-y-1 text-xs">{withKeys(preview.first, 'l').map(({ key, item: l }) => <li key={key}>{l.date} · {lineLabel(l.description, l.reference)} · <b className={Number(l.amount) < 0 ? 'text-red-700' : 'text-green-700'}>{money(l.amount)}</b></li>)}</ul>
              <button type="button" className={primaryClass} disabled={busy || preview.newCount === 0} onClick={() => void doImport()}>Import {preview.newCount} line{preview.newCount === 1 ? '' : 's'}</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
