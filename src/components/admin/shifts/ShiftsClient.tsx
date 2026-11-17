'use client';

import { Suspense, use, useState } from 'react';
import { closeShiftAction, openShiftAction, shiftHistoryAction, shiftMovementAction, shiftReportAction, shiftsScreenAction, withdrawShiftCloseAction, type ShiftsScreen } from '@/server/domains/selling/shifts/shift-actions';
import type { ShiftReport, ShiftRow } from '@/server/domains/selling/shifts/shift-service';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, PageHeader, PageSkeleton, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import type { Choice } from '@/lib/payment-options';
import { CashCounter, type CountValue } from './CashCounter';
import { ShiftReportView } from './ShiftReportView';

type First = Awaited<ReturnType<typeof shiftsScreenAction>>;
type Notice = { kind: 'ok' | 'error'; text: string } | null;

export function ShiftsClient({ firstPromise }: { firstPromise: Promise<First> }) {
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <Suspense fallback={<PageSkeleton label="Loading the shifts" />}>
        <Loaded firstPromise={firstPromise} />
      </Suspense>
    </div>
  );
}

function Loaded({ firstPromise }: { firstPromise: Promise<First> }) {
  const first = use(firstPromise);
  if (!first.ok) return <LoadFailed error={first.error} />;
  return <Body initial={first.data} />;
}

const money = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Body({ initial }: { initial: ShiftsScreen }) {
  const [data, setData] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [shown, setShown] = useState<ShiftReport | null>(null);
  const [version, setVersion] = useState(0);
  const reload = async () => {
    const r = await shiftsScreenAction();
    if (r.ok) {
      setData(r.data);
      setVersion((n) => n + 1);
    }
  };
  return (
    <>
      <PageHeader title="Shifts" intro="A shift is one person's time on one till: opened with the float counted, closed with the cash counted. A difference needs its reason, and a till that is out by more than the company allows is closed by a supervisor or goes to approval, as the company chose." />
      {notice === null ? null : <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm ${notice.kind === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-700' : 'border-emerald-500/30 bg-emerald-500/10 text-fg'}`} data-testid="shift-notice">{notice.text}</p>}
      {data.mine === null && data.can.open ? <OpenForm onOpened={async () => { setNotice({ kind: 'ok', text: 'Shift opened.' }); setShown(null); await reload(); }} /> : null}
      {data.mine === null && !data.can.open ? <p className="text-sm text-fg-muted">You have no shift open.</p> : null}
      {data.mine === null ? null : (
        <>
          <ShiftReportView report={data.mine} />
          {data.mine.status === 'closing' ? <Waiting report={data.mine} canWithdraw={data.can.close || data.can.supervise} onWithdrawn={async () => { setNotice({ kind: 'ok', text: 'The request was withdrawn. The shift is open again.' }); await reload(); }} onError={(text) => setNotice({ kind: 'error', text })} /> : null}
          {data.can.open && data.mine.status === 'open' ? <MovementForm shiftId={data.mine.id} onDone={async (text) => { setNotice({ kind: 'ok', text }); await reload(); }} onError={(text) => setNotice({ kind: 'error', text })} /> : null}
          {(data.can.close || data.can.supervise) && data.mine.status === 'open' ? (
            <CloseForm shiftId={data.mine.id} supervisor={data.can.supervise} approval={data.supervisorClose === 'approval'} onClosed={async (z, variance) => {
              if (z === null) {
                setNotice({ kind: 'ok', text: `The close is waiting for approval (difference ${money(variance)}). No cash can move on this shift until it is decided.` });
                await reload();
                return;
              }
              setNotice({ kind: 'ok', text: `Shift closed. Z report ${z}${variance === 0 ? ': the till was right.' : `: difference ${money(variance)}.`}` });
              const r = await shiftReportAction(data.mine?.id);
              setShown(r.ok ? r.data : null);
              await reload();
            }} />
          ) : null}
        </>
      )}
      {shown === null || (data.mine !== null && shown.id === data.mine.id) ? null : <ShiftReportView report={shown} />}
      {shown !== null && shown.status === 'open' && data.can.supervise && shown.openedById !== data.mine?.openedById ? (
        <CloseForm shiftId={shown.id} supervisor approval={false} onClosed={async (z) => { setNotice({ kind: 'ok', text: `Shift closed. Z report ${z ?? ''}.` }); setShown(null); await reload(); }} />
      ) : null}
      <History key={version} data={data} onOpen={(report) => { setShown(report); setNotice(null); }} />
    </>
  );
}

function OpenForm({ onOpened }: { onOpened: () => Promise<void> }) {
  const [register, setRegister] = useState<Choice | null>(null);
  const [float, setFloat] = useState<CountValue | null>({ counted: [] });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const open = async () => {
    if (register === null || float === null) return;
    setBusy(true);
    setProblem(null);
    const r = await openShiftAction({ registerId: register.id, float });
    setBusy(false);
    if (r.ok) await onOpened();
    else setProblem(r.error);
  };
  return (
    <form aria-label="Open a shift" className={`${cardClass} space-y-3`} onSubmit={(e) => { e.preventDefault(); void open(); }}>
      <h2 className="text-base font-bold text-fg-strong">Open a shift</h2>
      <ChoicePicker label="Till" source="shift-registers" choice={register} onChoice={setRegister} placeholder="Choose a till…" required />
      <CashCounter label="Count the float in the drawer" onChange={setFloat} />
      {problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="shift-problem">{problem}</p>}
      <button type="submit" className={primaryClass} disabled={busy || register === null || float === null}>{busy ? 'Opening…' : 'Open shift'}</button>
    </form>
  );
}

function MovementForm({ shiftId, onDone, onError }: { shiftId: string; onDone: (text: string) => Promise<void>; onError: (text: string) => void }) {
  const [kind, setKind] = useState<'paid_in' | 'paid_out'>('paid_in');
  const [amount, setAmount] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const record = async () => {
    setBusy(true);
    const r = await shiftMovementAction({ shiftId, kind, amount: Number(amount), reason: why });
    setBusy(false);
    if (r.ok) {
      setAmount('');
      setWhy('');
      await onDone(kind === 'paid_in' ? 'Cash put in recorded.' : 'Cash taken out recorded.');
    } else onError(r.error);
  };
  return (
    <form aria-label="Cash in or out" className={`${cardClass} space-y-3`} onSubmit={(e) => { e.preventDefault(); void record(); }}>
      <h2 className="text-base font-bold text-fg-strong">Cash in or out</h2>
      <SegmentedChoice label="Kind" value={kind} options={[{ value: 'paid_in', label: 'Put in' }, { value: 'paid_out', label: 'Take out' }]} onChange={setKind} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="movement-amount" label="Amount (KES)"><input id="movement-amount" type="number" min={0} step="0.01" className={fieldClass} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field id="movement-why" label="Why"><input id="movement-why" className={fieldClass} value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} /></Field>
      </div>
      <button type="submit" className={buttonClass} disabled={busy || amount === '' || why.trim().length < 3}>{busy ? 'Recording…' : 'Record'}</button>
    </form>
  );
}

function CloseForm({ shiftId, supervisor, approval, onClosed }: { shiftId: string; supervisor: boolean; approval: boolean; onClosed: (zNumber: string | null, variance: number) => Promise<void> }) {
  const [declared, setDeclared] = useState<CountValue | null>({ counted: [] });
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = async () => {
    if (declared === null) return;
    setBusy(true);
    setProblem(null);
    const r = await closeShiftAction({ shiftId, declared, reason: why });
    setBusy(false);
    if (r.ok) await onClosed(r.data.zNumber, r.data.variance);
    else setProblem(r.error);
  };
  return (
    <form aria-label="Close the shift" className={`${cardClass} space-y-3`} onSubmit={(e) => { e.preventDefault(); void close(); }}>
      <h2 className="text-base font-bold text-fg-strong">Close the shift{supervisor ? ' (as a supervisor)' : ''}</h2>
      {approval ? <p className="text-sm text-fg-muted">If the till is out by more than the company allows, the close goes to approval and the shift is held until it is decided.</p> : null}
      <CashCounter label="Count the cash in the drawer" onChange={setDeclared} />
      <Field id={`close-why-${shiftId}`} label="Reason for any difference"><input id={`close-why-${shiftId}`} className={fieldClass} value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} /></Field>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="shift-problem">{problem}</p>}
      <button type="submit" className={primaryClass} disabled={busy || declared === null}>{busy ? 'Closing…' : 'Close shift'}</button>
    </form>
  );
}

function StatusChip({ row }: { row: ShiftRow }) {
  if (row.status === 'open') return <Chip tone="amber">Open</Chip>;
  if (row.status === 'closing') return <Chip tone="amber">Waiting for approval</Chip>;
  if (row.variance === 0) return <Chip tone="green">Till right</Chip>;
  return <Chip tone="red">{`Difference ${money(row.variance ?? 0)}`}</Chip>;
}

function Waiting({ report, canWithdraw, onWithdrawn, onError }: { report: ShiftReport; canWithdraw: boolean; onWithdrawn: () => Promise<void>; onError: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const ask = report.closeRequest;
  const withdraw = async () => {
    setBusy(true);
    const r = await withdrawShiftCloseAction(report.id);
    setBusy(false);
    if (r.ok) await onWithdrawn();
    else onError(r.error);
  };
  return (
    <section className={`${cardClass} space-y-2`} aria-label="Waiting for approval" data-testid="shift-waiting">
      <h2 className="text-base font-bold text-fg-strong">Waiting for approval</h2>
      <p className="text-sm text-fg-muted">
        {ask === null ? 'The close of this shift is waiting for approval.' : `${ask.requestedBy} counted ${money(ask.declaredCash)}, a difference of ${money(ask.variance)} ("${ask.reason}"). No cash can be added or taken out until it is decided.`}
      </p>
      {canWithdraw ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void withdraw()}>{busy ? 'Withdrawing…' : 'Withdraw the request and recount'}</button> : null}
    </section>
  );
}

function History({ data, onOpen }: { data: ShiftsScreen; onOpen: (report: ShiftReport) => void }) {
  const [rows, setRows] = useState<ShiftRow[]>(data.history.rows);
  const [cursor, setCursor] = useState(data.history.nextCursor);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showMore = async () => {
    if (cursor === null) return;
    setMore(true);
    const r = await shiftHistoryAction({ cursor });
    setMore(false);
    if (r.ok) {
      setRows((current) => [...current, ...r.data.rows]);
      setCursor(r.data.nextCursor);
    } else setError(r.error);
  };
  const open = async (id: string) => {
    const r = await shiftReportAction(id);
    if (r.ok && r.data !== null) onOpen(r.data);
    else setError(r.ok ? 'That shift could not be found.' : r.error);
  };
  return (
    <section className="space-y-2" aria-label="Shifts so far">
      <h2 className="text-sm font-bold tracking-wider text-fg-subtle uppercase">Shifts so far</h2>
      {rows.length === 0 ? <p className="text-sm text-fg-muted" data-testid="shifts-empty">No shifts yet.</p> : (
        <ul className="space-y-2" data-testid="shift-history">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-3" data-testid="shift-row">
              <div className="min-w-0">
                <p className="font-semibold break-words text-fg-strong">{r.zNumber ?? 'Open'} · {r.registerName}</p>
                <p className="text-sm break-words text-fg-muted">{r.openedBy} · {new Date(r.openedAt).toLocaleString()}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip row={r} />
                <button type="button" className={buttonClass} aria-label={`Open the shift ${r.zNumber ?? r.registerName}`} onClick={() => void open(r.id)}>Open</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : <p role="alert" className="text-sm text-red-700">{error}</p>}
      {cursor === null ? null : <button type="button" className={buttonClass} disabled={more} onClick={() => void showMore()}>{more ? 'Loading…' : 'Show more'}</button>}
    </section>
  );
}
