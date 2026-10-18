'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { generateRefundFileAction, type listRefundFilesAction, type refundFileCandidatesAction } from '@/server/domains/finance/refund-file-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { REFUND_FILE_STATUS, statusInfo } from '@/lib/finance-statuses';
import { fileProblem, ownApprovals, pickedTotal, toggleAll, toggleOne } from '@/lib/refund-file-form';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, money, primaryClass, today, type Notice } from './ui';

type Files = Extract<Awaited<ReturnType<typeof listRefundFilesAction>>, { ok: true }>['data'];
type Candidates = Extract<Awaited<ReturnType<typeof refundFileCandidatesAction>>, { ok: true }>['data'];

export function RefundFilesClient({ filesPromise, candidatesPromise }: { filesPromise: ReturnType<typeof listRefundFilesAction>; candidatesPromise: ReturnType<typeof refundFileCandidatesAction> }) {
  const files = use(filesPromise);
  const candidates = use(candidatesPromise);
  if (!files.ok) return <LoadFailed error={files.error} />;
  return <RefundFilesView files={files.data} candidates={candidates.ok ? candidates.data : null} />;
}

function RefundFilesView({ files, candidates }: { files: Files; candidates: Candidates | null }) {
  const uid = useId();
  const router = useRouter();
  const rows = candidates?.rows ?? [];
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [method, setMethod] = useState<Choice | null>(null);
  const [format, setFormat] = useState<Choice | null>({ id: 'csv', label: 'CSV (opens in Excel; most banks\' upload tools)' });
  const [when, setWhen] = useState(today());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const mine = ownApprovals(rows, picked, candidates?.me ?? null);
  const make = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = fileProblem({ methodId: method?.id ?? null, formatId: format?.id ?? null, picked: picked.size, executionDate: when, today: today() });
    if (problem !== null) { setNotice({ kind: 'error', text: problem }); return; }
    setBusy(true);
    setNotice(null);
    const res = await attempt(generateRefundFileAction({ methodId: method?.id ?? '', format: (format?.id ?? 'csv') as 'csv' | 'pain001', refundIds: [...picked], executionDate: when }));
    if (!res.ok) { setBusy(false); setNotice({ kind: 'error', text: res.error }); return; }
    router.push(`/admin/finance/refunds/files/${res.data.id}`);
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Bank payment files"
        intro="Approved refunds paid by bank transfer go into one file that you upload to the bank. When the bank has paid it, someone else records the whole file as paid at once."
        actions={<Link href="/admin/finance/refunds" className={buttonClass}>All refunds</Link>}
      />
      <Message notice={notice} />

      {files.can.generate ? (
        <form onSubmit={(e) => void make(e)} className={`${cardClass} space-y-4`} aria-label="Make a payment file">
          <h2 className="text-sm font-bold text-fg-strong">Make a file</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-fg-muted">No approved bank-transfer refunds are waiting to be paid.</p>
          ) : (
            <>
              <fieldset className="space-y-1">
                <legend className="text-xs font-semibold text-fg-muted">Refunds to put in the file ({rows.length}{rows.length >= 200 ? ', the oldest 200' : ''})</legend>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={picked.size === rows.length} onChange={() => setPicked(toggleAll(rows, picked))} /> Tick all</label>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <label className="flex min-h-10 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                        <input type="checkbox" checked={picked.has(r.id)} onChange={() => setPicked(toggleOne(picked, r.id))} />
                        <span className="font-semibold text-fg-strong">{r.number}</span>
                        <span className="min-w-0 flex-1 break-words text-fg-muted">{r.customer}</span>
                        <span className="font-semibold">{r.currency} {money(r.amount)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              <p className="text-sm" aria-live="polite"><strong>{picked.size}</strong> chosen · total <strong>{pickedTotal(rows, picked)}</strong></p>
              {mine.length > 0 ? <p role="alert" className="text-sm text-red-700">You approved {mine.length === 1 ? 'one of these' : `${String(mine.length)} of these`}, so you cannot also send {mine.length === 1 ? 'it' : 'them'} to the bank. Untick {mine.length === 1 ? 'it' : 'them'}; someone else makes the file.</p> : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <ChoicePicker label="Pay from" source="refund-file-methods" choice={method} onChoice={setMethod} clearable={false} required placeholder="Choose the bank…" />
                <ChoicePicker label="File format" source="refund-file-formats" choice={format} onChoice={setFormat} clearable={false} required />
                <Field id={`${uid}-d`} label="Bank should pay on"><input id={`${uid}-d`} type="date" min={today()} value={when} onChange={(e) => setWhen(e.target.value)} className={fieldClass} required /></Field>
              </div>
              <button type="submit" className={primaryClass} disabled={busy || picked.size === 0}>Make the file</button>
            </>
          )}
        </form>
      ) : null}

      <section className="space-y-2" aria-label="Payment files">
        <h2 className="text-sm font-bold text-fg-strong">Files made</h2>
        {files.rows.length === 0 ? <p className="text-sm text-fg-muted">No files yet.</p> : (
          <ul className="space-y-2">
            {files.rows.map((f) => (
              <li key={f.id}>
                <Link href={`/admin/finance/refunds/files/${f.id}`} className={`${cardClass} block min-h-10 hover:bg-hover`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-sm font-bold text-fg-strong">{f.number} <span className="font-normal text-fg-muted">· {f.count} {f.count === 1 ? 'refund' : 'refunds'}</span></p>
                    <Chip tone={statusInfo(REFUND_FILE_STATUS, f.status).tone}>{statusInfo(REFUND_FILE_STATUS, f.status).label}</Chip>
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">{f.currency} {money(f.total)} · {f.format === 'csv' ? 'CSV' : 'ISO 20022'} · {new Date(f.createdAt).toLocaleDateString()} · downloaded {f.downloads} {f.downloads === 1 ? 'time' : 'times'}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
