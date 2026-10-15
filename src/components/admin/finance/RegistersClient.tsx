'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  listReasonsAction,
  registerDetailAction,
  reverseRegisterAction,
  verifyChainAction,
  type RegisterView,
} from '@/server/domains/finance/actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, fieldClass, money, primaryClass, today, type Notice, attempt } from './ui';

import { has } from '@/lib/has';
import { readText } from '@/lib/values';

type Detail = Extract<Awaited<ReturnType<typeof registerDetailAction>>, { ok: true }>['data'];
type Chain = Extract<Awaited<ReturnType<typeof verifyChainAction>>, { ok: true }>['data'];

export function RegistersClient({ registers, canReverse }: { registers: RegisterView[]; canReverse: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const [reasons, setReasons] = useState<{ code: string; description: string; requiresComment: boolean }[]>([]);
  const [rev, setRev] = useState({ date: today(), code: '', text: '' });
  const [chain, setChain] = useState<Chain | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const toggle = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setDetail(null);
    const res = await attempt(registerDetailAction(id));
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setDetail(res.data);
  };

  const startReverse = async (id: string) => {
    setReversing(id);
    setNotice(null);
    if (reasons.length === 0) {
      const res = await attempt(listReasonsAction());
      if (res.ok) { setReasons(res.data); setRev((r) => ({ ...r, code: res.data[0]?.code ?? '' })); }
    }
  };

  const reverse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!has(reversing)) return;
    setBusy(true);
    const res = await attempt(reverseRegisterAction(reversing, rev.date, { code: rev.code, text: rev.text }));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: 'Reversed. The original stays in the books; the reversal is a new posting linked to it.' });
    setReversing(null);
    router.refresh();
  };

  const verify = async () => {
    setBusy(true);
    const res = await attempt(verifyChainAction());
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setChain(res.data);
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Postings (ledger registers)"
        intro="One row per posting. Each is chained to the one before it, so any later change to the books can be detected."
        actions={<button type="button" className={buttonClass} onClick={verify} disabled={busy}>Verify the chain</button>}
      />
      <Message notice={notice} />
      {chain ? (
        <div className={`${cardClass} space-y-1`} role="status">
          {chain.length === 0 ? <p className="text-sm text-fg-muted">Nothing to verify yet.</p> : null}
          {chain.map((c) => (
            <p key={c.chainKey} className={`text-sm ${c.ok ? 'text-emerald-700' : 'text-red-700'}`}>
              {c.ok ? '✓' : '✗'} Chain “{c.chainKey}”: {c.ok ? `${c.checked} postings intact.` : c.problem}
            </p>
          ))}
        </div>
      ) : null}

      {has(reversing) ? (
        <form onSubmit={reverse} className={`${cardClass} space-y-3`} aria-label="Reverse posting">
          <p className="text-sm font-semibold text-fg-strong">Reverse this posting</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field id={`${uid}-rd`} label="Reversal date"><input id={`${uid}-rd`} type="date" value={rev.date} onChange={(e) => setRev({ ...rev, date: e.target.value })} className={fieldClass} required /></Field>
            <Field id={`${uid}-rc`} label="Reason">
              <select id={`${uid}-rc`} value={rev.code} onChange={(e) => setRev({ ...rev, code: e.target.value })} className={fieldClass} required>
                {reasons.map((r) => <option key={r.code} value={r.code}>{r.description}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-rt`} label="Comment"><input id={`${uid}-rt`} value={rev.text} onChange={(e) => setRev({ ...rev, text: e.target.value })} className={fieldClass} /></Field>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || rev.code === ''} className={primaryClass}>Reverse</button>
            <button type="button" className={buttonClass} onClick={() => setReversing(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      <ul className="space-y-2">
        {registers.map((r) => (
          <li key={r.id} className="rounded-xl border border-line bg-surface-raised">
            <button
              type="button"
              onClick={() => toggle(r.id)}
              aria-expanded={open === r.id}
              className="flex min-h-12 w-full cursor-pointer flex-wrap items-center justify-between gap-2 p-3 text-left hover:bg-hover"
            >
              <span className="text-sm text-fg-strong">
                <span className="font-mono text-xs text-fg-muted">{r.chainKey}-{r.seq}</span> · <span className="font-mono">{r.documentNo}</span>
                <span className="ml-2 text-xs text-fg-muted">{r.postingDate}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm tabular-nums">{money(r.total)} <span className="text-xs text-fg-muted">{r.currency}</span></span>
                {r.isReversal ? <Chip tone="amber">Reversal</Chip> : null}
                {r.reversed ? <Chip tone="gray">Reversed</Chip> : null}
              </span>
            </button>
            {open === r.id ? (
              <div className="space-y-3 border-t border-line p-3 text-sm">
                {!detail ? <p className="text-fg-muted">Loading…</p> : (
                  <>
                    <ul className="space-y-1 text-xs">
                      {detail.lines.map((l) => (
                        <li key={l.lineNo} className="flex justify-between gap-3"><span><span className="font-mono">{l.accountNo}</span> {l.accountName}</span><span className="tabular-nums">{Number(l.debit) !== 0 ? `Dr ${money(l.debit)}` : `Cr ${money(l.credit)}`}</span></li>
                      ))}
                    </ul>
                    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                      <div><dt className="inline text-fg-muted">Posted by </dt><dd className="inline text-fg">{r.postedBy ?? 'system'} at {new Date(r.postedAt).toLocaleString()}</dd></div>
                      <div><dt className="inline text-fg-muted">From </dt><dd className="inline text-fg">{readText((detail.origin).surface, '—')} → {readText((detail.origin).action, '—')}</dd></div>
                      <div><dt className="inline text-fg-muted">Permission </dt><dd className="inline text-fg">{readText((detail.origin).permissionUsed, '—')}</dd></div>
                      <div><dt className="inline text-fg-muted">IP </dt><dd className="inline text-fg">{readText((detail.origin).ip, '—')}</dd></div>
                      <div className="sm:col-span-2 break-all"><dt className="inline text-fg-muted">Hash </dt><dd className="inline font-mono text-[10px] text-fg">{detail.hash}</dd></div>
                    </dl>
                    {detail.trail.length > 0 ? (
                      <ol className="space-y-1 border-l border-line pl-3 text-xs">
                        {detail.trail.map((t, i) => <li key={i}><span className="text-fg-muted">{new Date(t.at).toLocaleString()}</span> {t.action} {has(t.reason) ? `— ${t.reason}` : ''}</li>)}
                      </ol>
                    ) : null}
                    {canReverse && !r.isReversal && !r.reversed ? <button type="button" className={buttonClass} onClick={() => startReverse(r.id)}>Reverse…</button> : null}
                  </>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {registers.length === 0 ? <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-fg-muted">Nothing has been posted yet.</div> : null}
    </div>
  );
}
