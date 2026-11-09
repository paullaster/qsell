'use client';

import { use, useEffect, useId, useMemo, useState } from 'react';
import { addCourierInvoiceAction, courierInvoiceChargesAction, courierInvoicesPageAction, courierInvoicesScreenAction, matchCourierChargesAction, unmatchCourierChargeAction, voidCourierInvoiceAction } from '@/server/domains/delivery/courier-invoice-actions';
import type { ChargeView, InvoiceView } from '@/server/domains/delivery/courier-invoices';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import type { Choice } from '@/lib/payment-options';
import type { InvoiceState } from '@/lib/courier-invoice';

type Loaded = Awaited<ReturnType<typeof courierInvoicesScreenAction>>;
type Data = Extract<Loaded, { ok: true }>['data'];

const TONE: Record<InvoiceState, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { open: 'sky', agreed: 'green', short: 'amber', over: 'red' };
const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

export function CourierInvoicesClient({ firstPromise }: { firstPromise: ReturnType<typeof courierInvoicesScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Screen initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Screen({ initial }: { initial: Data }) {
  const [notice, setNotice] = useState<Notice>(null);
  const [unbilled, setUnbilled] = useState(initial.unbilled);
  const list = usePagedList<InvoiceView, { all: string }>({
    load: async (_filters, cursor) => {
      const r = await courierInvoicesPageAction({ cursor });
      return r.ok ? { ok: true, data: { rows: r.data.rows, nextCursor: r.data.nextCursor } } : { ok: false, error: r.error };
    },
    filters: { all: '' },
    initialPage: { ok: true, data: { rows: initial.rows, nextCursor: initial.nextCursor } },
  });
  const refreshUnbilled = async () => {
    const r = await attempt(courierInvoicesScreenAction());
    if (r.ok) setUnbilled(r.data.unbilled);
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Courier invoices" intro="Type in an invoice a courier sent, then match it to the charges we kept for that courier's parcels. It shows whether the two agree, and by how much they differ. Matching changes no charge and posts nothing; paying the invoice is done in the usual way." />
      <Message notice={notice} />
      <Unbilled rows={unbilled} />
      <AddForm
        onAdded={() => {
          setNotice({ kind: 'ok', text: 'The invoice is recorded. Match its charges below.' });
          list.reload();
        }}
        onError={(text) => setNotice({ kind: 'error', text })}
      />
      <section aria-label="Invoices" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Invoices</h3>
        {list.phase === 'error' ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {list.error}{' '}
            <button type="button" className={buttonClass} onClick={list.retry}>
              Try again
            </button>
          </p>
        ) : null}
        {list.phase === 'loading' ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading…
          </p>
        ) : null}
        {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No courier invoice has been typed in yet.
          </p>
        ) : null}
        <ul className="space-y-3" aria-label="Invoice list">
          {list.rows.map((inv) => (
            <InvoiceCard
              key={inv.id}
              invoice={inv}
              onChanged={(text) => {
                setNotice({ kind: 'ok', text });
                void refreshUnbilled();
              }}
              onError={(text) => setNotice({ kind: 'error', text })}
            />
          ))}
        </ul>
        {list.cursor !== null ? (
          <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
            {list.phase === 'more' ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function Unbilled({ rows }: { rows: Data['unbilled'] }) {
  return (
    <section aria-label="Not on an invoice" className={`${cardClass} space-y-2`}>
      <h3 className="text-sm font-bold text-fg-strong">Charged to us, on no invoice yet</h3>
      {rows.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">
          Every courier charge we have kept is on an invoice, or there are none.
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Unbilled list">
          {rows.map((r) => (
            <li key={r.courier} className="flex items-center justify-between gap-3 py-2">
              <span className="font-semibold text-fg-strong">{r.courier === '' ? 'Courier not named' : r.courier}</span>
              <span className="text-fg">
                {r.count} {r.count === 1 ? 'charge' : 'charges'} · KES {r.total}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddForm({ onAdded, onError }: { onAdded: () => void; onError: (text: string) => void }) {
  const [fresh, setFresh] = useState(0);
  return (
    <AddFormBody
      key={fresh}
      onAdded={() => {
        setFresh((n) => n + 1);
        onAdded();
      }}
      onError={onError}
    />
  );
}

function AddFormBody({ onAdded, onError }: { onAdded: () => void; onError: (text: string) => void }) {
  const uid = useId();
  const [courier, setCourier] = useState<Choice | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [total, setTotal] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = courier !== null && invoiceNo.trim() !== '' && invoiceDate !== '' && total.trim() !== '' && !Number.isNaN(Number(total));
  const save = async () => {
    setBusy(true);
    const r = await attempt(addCourierInvoiceAction({ courierName: courier?.id, invoiceNo, invoiceDate, total: Number(total), note }));
    setBusy(false);
    if (r.ok) onAdded();
    else onError(r.error);
  };
  return (
    <form
      aria-label="Type in an invoice"
      className={`${cardClass} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-bold text-fg-strong">Type in an invoice</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="Courier" source="delivery-charged-couriers" choice={courier} onChoice={setCourier} placeholder="Choose the courier" />
        <Field id={`${uid}-no`} label="Invoice number">
          <input id={`${uid}-no`} className={fieldClass} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} autoComplete="off" />
        </Field>
        <Field id={`${uid}-d`} label="Day on the invoice">
          <input id={`${uid}-d`} type="date" className={fieldClass} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
        <Field id={`${uid}-t`} label="Invoice total (KSh)">
          <input id={`${uid}-t`} className={fieldClass} inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} autoComplete="off" />
        </Field>
        <Field id={`${uid}-n`} label="Note (optional)">
          <input id={`${uid}-n`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoComplete="off" />
        </Field>
      </div>
      <button type="submit" className={primaryClass} disabled={busy || !ready}>
        {busy ? 'Saving…' : 'Record the invoice'}
      </button>
    </form>
  );
}

function InvoiceCard({ invoice, onChanged, onError }: { invoice: InvoiceView; onChanged: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [inv, setInv] = useState(invoice);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const voided = inv.voided !== null;
  const diff = Number(inv.difference);
  const run = async (fn: () => Promise<Awaited<ReturnType<typeof matchCourierChargesAction>>>, done: string) => {
    setBusy(true);
    const r = await attempt(fn());
    setBusy(false);
    if (r.ok) {
      setInv(r.data);
      onChanged(done);
      return true;
    }
    onError(r.error);
    return false;
  };
  return (
    <li className="space-y-2 rounded-xl border border-line bg-surface-raised p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-semibold text-fg-strong">
          {inv.courierName} · {inv.invoiceNo}
        </span>
        {voided ? <Chip tone="gray">Voided</Chip> : <Chip tone={TONE[inv.state]}>{inv.stateWords}</Chip>}
      </div>
      <p className="text-xs text-fg-muted">
        Invoice day {inv.invoiceDate} · typed in {when(inv.createdAt)}
        {inv.note === null ? '' : ` · ${inv.note}`}
      </p>
      <dl className="grid grid-cols-3 gap-2">
        <div>
          <dt className="text-xs text-fg-muted">Invoice total</dt>
          <dd className="font-mono font-semibold text-fg-strong">
            {inv.currency} {inv.total}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Our charges matched ({inv.matchedCount})</dt>
          <dd className="font-mono font-semibold text-fg-strong">
            {inv.currency} {inv.matched}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Difference</dt>
          <dd className={`font-mono font-semibold ${diff === 0 ? 'text-fg-strong' : 'text-red-700 dark:text-red-300'}`}>
            {inv.currency} {inv.difference}
          </dd>
        </div>
      </dl>
      {voided ? (
        <p className="text-xs text-fg-muted">
          Voided {inv.voided === null ? '' : when(inv.voided.at)}: {inv.voided?.reason}
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className={buttonClass} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Close the charges' : `Match charges to ${inv.invoiceNo}`}
          </button>
          <Field id={`${uid}-r`} label="Why it is being voided">
            <input id={`${uid}-r`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" />
          </Field>
          <InlineConfirm
            label={`Void invoice ${inv.invoiceNo}`}
            action="Void it"
            confirm="Yes, void it"
            busy={busy}
            onConfirm={() => void run(() => voidCourierInvoiceAction({ invoiceId: inv.id, reason }), 'The invoice is voided. Its charges can go on another invoice.')}
          />
        </div>
      )}
      {open && !voided ? <Charges invoiceId={inv.id} currency={inv.currency} busy={busy} onMatch={(ids) => run(() => matchCourierChargesAction({ invoiceId: inv.id, costIds: ids }), 'The charges are matched.')} onUnmatch={(id) => run(() => unmatchCourierChargeAction({ invoiceId: inv.id, costId: id }), 'The charge is taken off the invoice.')} version={`${String(inv.matchedCount)}|${inv.matched}`} /> : null}
    </li>
  );
}

function Charges({ invoiceId, currency, busy, onMatch, onUnmatch, version }: { invoiceId: string; currency: string; busy: boolean; onMatch: (ids: string[]) => Promise<boolean>; onUnmatch: (id: string) => Promise<boolean>; version: string }) {
  return <ChargesLoaded key={`${invoiceId}|${version}`} invoiceId={invoiceId} currency={currency} busy={busy} onMatch={onMatch} onUnmatch={onUnmatch} />;
}

function ChargesLoaded({ invoiceId, currency, busy, onMatch, onUnmatch }: { invoiceId: string; currency: string; busy: boolean; onMatch: (ids: string[]) => Promise<boolean>; onUnmatch: (id: string) => Promise<boolean> }) {
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'ready'; matched: ChargeView[]; candidates: ChargeView[]; more: boolean }>({ phase: 'loading' });
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    void attempt(courierInvoiceChargesAction(invoiceId)).then((r) => {
      if (current) setState(r.ok ? { phase: 'ready', ...r.data } : { phase: 'error', error: r.error });
    });
    return () => {
      current = false;
    };
  }, [invoiceId]);
  const total = useMemo(() => (state.phase === 'ready' ? state.candidates.filter((c) => picked.includes(c.costId)).reduce((n, c) => n + Math.round(Number(c.amount) * 100), 0) / 100 : 0), [state, picked]);
  if (state.phase === 'loading') {
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading the charges…
      </p>
    );
  }
  if (state.phase === 'error') {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-300">
        {state.error}
      </p>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
      <section aria-label="Charges on this invoice" className="space-y-1">
        <h4 className="text-xs font-bold text-fg-strong">On this invoice</h4>
        {state.matched.length === 0 ? (
          <p role="status" className="text-xs text-fg-muted">
            No charge is matched yet.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {state.matched.map((c) => (
              <li key={c.costId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  {c.deliveryNumber ?? 'Charge'} · {currency} {c.amount}
                  {c.note === null ? '' : ` · ${c.note}`}
                </span>
                <InlineConfirm label={`Take off the ${c.amount} charge ${c.deliveryNumber ?? ''}`.trim()} action="Take off" confirm="Yes, take it off" busy={busy} onConfirm={() => void onUnmatch(c.costId)} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Charges that could go on this invoice" className="space-y-1">
        <h4 className="text-xs font-bold text-fg-strong">Charges not on any invoice</h4>
        {state.candidates.length === 0 ? (
          <p role="status" className="text-xs text-fg-muted">
            This courier has no charge left to match.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {state.candidates.map((c) => (
              <li key={c.costId}>
                <label className="flex min-h-10 cursor-pointer items-center gap-3 py-1.5">
                  <input type="checkbox" className="size-5" checked={picked.includes(c.costId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.costId] : p.filter((x) => x !== c.costId)))} />
                  <span className="min-w-0">
                    {c.deliveryNumber ?? 'Charge'} · {currency} {c.amount} · {when(c.createdAt)}
                    {c.note === null ? '' : ` · ${c.note}`}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {state.more ? <p className="text-xs text-fg-muted">Only the latest charges are listed. Match these, then open this again for the rest.</p> : null}
        <button
          type="button"
          className={primaryClass}
          disabled={busy || picked.length === 0}
          onClick={() => {
            void onMatch(picked);
          }}
        >
          {picked.length === 0 ? 'Match the charges you tick' : `Match ${String(picked.length)} ${picked.length === 1 ? 'charge' : 'charges'} (${currency} ${total.toFixed(2)})`}
        </button>
      </section>
    </div>
  );
}
