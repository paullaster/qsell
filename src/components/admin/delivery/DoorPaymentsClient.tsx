'use client';

import { use, useEffect, useId, useState } from 'react';
import { approveHandInAction, doorBalancesAction, doorEntriesAction, finishDoorPostingAction, handInsAction, recordHandInAction, refuseHandInAction, setDoorCashMethodAction, setDoorDifferencesAction, setPayOnDeliveryAction, type doorSettingsAction } from '@/server/domains/delivery/door-payment-actions';
import type { HandInView } from '@/server/domains/delivery/door-hand-ins';
import type { CustodyEntryView, CustodyRiderView, DoorSettingsView } from '@/server/domains/delivery/door-payments';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { HAND_IN_WORDS, handInCheck, toCents, type HandInStatus } from '@/lib/door-payment';
import { usePagedList } from '@/components/ui/usePagedList';
import type { Choice } from '@/lib/payment-options';

type Loaded = Awaited<ReturnType<typeof doorSettingsAction>>;
type Settings = Extract<Loaded, { ok: true }>['data'];

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

export function DoorPaymentsClient({ settingsPromise }: { settingsPromise: ReturnType<typeof doorSettingsAction> }) {
  const res: Loaded = use(settingsPromise);
  return res.ok ? <Screen initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Screen({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [balances, setBalances] = useState<CustodyRiderView[] | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = usePagedList<CustodyEntryView, Record<string, never>>({
    load: async (_filters, cursor) => {
      const result = await doorEntriesAction({ cursor });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: {},
  });

  const handIns = usePagedList<HandInView, Record<string, never>>({
    load: async (_filters, cursor) => {
      const result = await handInsAction({ cursor });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: {},
  });

  const readBalances = async (): Promise<void> => {
    const r = await attempt(doorBalancesAction());
    if (r.ok) {
      setBalances(r.data);
      setBalanceError(null);
    } else setBalanceError(r.error);
  };
  // The balances are read once the screen is on, without holding the settings up.
  useEffect(() => {
    void attempt(doorBalancesAction()).then((r) => {
      if (r.ok) setBalances(r.data);
      else setBalanceError(r.error);
    });
  }, []);

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Door payments" intro="Cash riders collect when a delivery is paid at the door. It is held by the rider until they hand it in, and the sale is booked through the payment method you choose here." />
      <Message notice={notice} />
      <MethodPanel
        settings={settings}
        onSaved={(s) => {
          // The method and the differences share one saved record, so one version: a save of either moves both.
          setSettings({ ...settings, ...s, differences: { ...settings.differences, version: s.version } });
          setNotice({ kind: 'ok', text: 'Saved. Cash taken at doors is received through this method from now on.' });
        }}
        onError={(text) => setNotice({ kind: 'error', text })}
      />
      <PayOnDeliveryPanel
        settings={settings}
        onSaved={(s) => {
          setSettings({ ...settings, ...s, differences: { ...settings.differences, version: s.version } });
          setNotice({ kind: 'ok', text: s.payOnDelivery ? 'Saved. Shoppers can now choose to pay on delivery.' : 'Saved. Shoppers can no longer choose to pay on delivery.' });
        }}
        onError={(text) => setNotice({ kind: 'error', text })}
      />
      <DifferencesPanel
        settings={settings}
        onSaved={(differences) => {
          setSettings({ ...settings, version: differences.version, differences });
          setNotice({ kind: 'ok', text: 'Saved. A hand-in that is out by more than this waits for a second person.' });
        }}
        onError={(text) => setNotice({ kind: 'error', text })}
      />

      <section aria-label="What riders hold" className={`${cardClass} space-y-3`}>
        <h3 className="text-sm font-bold text-fg-strong">What riders hold</h3>
        {balanceError === null ? null : <p role="alert" className="text-sm text-red-700 dark:text-red-300">{balanceError}</p>}
        {balances === null && balanceError === null ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading…
          </p>
        ) : null}
        {balances !== null && balances.length === 0 ? (
          <p role="status" className="text-sm text-fg-muted">
            No rider has collected cash yet.
          </p>
        ) : null}
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Riders and their cash">
          {(balances ?? []).map((b) => (
            <li key={b.riderId} className="space-y-1 rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-fg-strong">{b.name}</span>
                {b.status === 'active' ? null : <Chip tone="gray">{b.status === 'paused' ? 'Paused' : 'Left'}</Chip>}
              </div>
              <p className="text-2xl font-bold text-fg-strong">KSh {b.balance}</p>
              <p className="text-xs text-fg-muted">
                Collected today KSh {b.collectedToday}
                {b.lastAt === null ? '' : ` · last on ${when(b.lastAt)}`}
              </p>
              {settings.canHandIn && toCents(b.balance) > 0 ? (
                <HandInForm
                  rider={b}
                  onDone={(view) => {
                    setNotice({ kind: 'ok', text: view.status === 'posted' ? `${view.number}: KSh ${view.counted} handed in by ${view.riderName}.` : `${view.number} is waiting for approval: the count is out by KSh ${view.difference.replace('-', '')}.` });
                    void readBalances();
                    list.reload();
                    handIns.reload();
                  }}
                  onError={(text) => setNotice({ kind: 'error', text })}
                />
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await attempt(finishDoorPostingAction());
              setBusy(false);
              if (!r.ok) setNotice({ kind: 'error', text: r.error });
              else setNotice({ kind: 'ok', text: r.data.checked === 0 ? 'Every collection is already stocked and booked.' : `${String(r.data.finished)} of ${String(r.data.checked)} collections finished.` });
              list.reload();
              void readBalances();
            }}
          >
            Finish any collection not yet booked
          </button>
        </div>
      </section>

      <section aria-label="Hand-ins" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Hand-ins</h3>
        {handIns.phase === 'loading' ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading…
          </p>
        ) : null}
        {handIns.phase === 'error' ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {handIns.error}{' '}
            <button type="button" className={buttonClass} onClick={handIns.retry}>
              Try again
            </button>
          </p>
        ) : null}
        {handIns.phase !== 'loading' && handIns.phase !== 'error' && handIns.rows.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No cash has been handed in yet.
          </p>
        ) : null}
        <ul className="space-y-2" aria-label="Hand-in list">
          {handIns.rows.map((h) => (
            <HandInRow
              key={h.id}
              h={h}
              canApprove={settings.canApprove}
              onDone={(text) => {
                setNotice({ kind: 'ok', text });
                void readBalances();
                list.reload();
                handIns.reload();
              }}
              onError={(text) => setNotice({ kind: 'error', text })}
            />
          ))}
        </ul>
        {handIns.cursor !== null ? (
          <button type="button" className={buttonClass} onClick={handIns.loadMore} disabled={handIns.phase === 'more'}>
            {handIns.phase === 'more' ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
      </section>

      <section aria-label="Custody ledger" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Custody ledger</h3>
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
            Nothing has been collected at a door yet.
          </p>
        ) : null}
        <ul className="space-y-2" aria-label="Custody entries">
          {list.rows.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-line bg-surface-raised p-3 text-sm">
              <span className="min-w-0">
                <span className="font-semibold text-fg-strong">{e.riderName}</span> · {e.kindWords}
                {e.deliveryNumber === null ? '' : ` · ${e.deliveryNumber}`}
                {e.orderNumber === null ? '' : ` · order ${e.orderNumber}`}
                <span className="block text-xs text-fg-muted">{when(e.createdAt)}{e.note === null ? '' : ` · ${e.note}`}</span>
              </span>
              <span className={`font-mono font-semibold ${Number(e.amount) < 0 ? 'text-red-700 dark:text-red-300' : 'text-fg-strong'}`}>
                {e.currency} {e.amount}
              </span>
            </li>
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

function MethodPanel({ settings, onSaved, onError }: { settings: Settings; onSaved: (s: DoorSettingsView) => void; onError: (text: string) => void }) {
  const [choice, setChoice] = useState<Choice | null>(settings.cashMethodId === null ? null : { id: settings.cashMethodId, label: settings.cashMethodName ?? '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (choice === null) return;
    setBusy(true);
    const result = await attempt(setDoorCashMethodAction({ cashMethodId: choice.id, expectedVersion: settings.version }));
    setBusy(false);
    if (result.ok) onSaved(result.data);
    else onError(result.error);
  };
  return (
    <section aria-label="How cash is received" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">How cash at the door is received</h3>
      <p className="text-xs text-fg-muted">
        Choose a payment method of kind cash whose account stands for &quot;cash with riders&quot;. Until it is handed in, cash collected sits in that account. Until you choose, no delivery can be marked to be paid at the door.
      </p>
      <ChoicePicker label="Payment method" source="door-cash-methods" choice={choice} onChoice={setChoice} placeholder="Choose a cash payment method" />
      <button type="button" className={primaryClass} disabled={busy || choice === null || choice.id === settings.cashMethodId} onClick={() => void save()}>
        Save
      </button>
    </section>
  );
}

const TONE: Record<HandInStatus, 'green' | 'amber' | 'red'> = { posted: 'green', pending_approval: 'amber', rejected: 'red' };

function DifferencesPanel({ settings, onSaved, onError }: { settings: Settings; onSaved: (d: Settings['differences']) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [limit, setLimit] = useState(settings.differences.varianceLimit);
  const [account, setAccount] = useState<Choice | null>(settings.differences.varianceGlAccountId === null ? null : { id: settings.differences.varianceGlAccountId, label: settings.differences.varianceAccountName ?? '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const result = await attempt(setDoorDifferencesAction({ varianceLimit: Number(limit), varianceGlAccountId: account?.id ?? '', expectedVersion: settings.differences.version }));
    setBusy(false);
    if (result.ok) onSaved(result.data);
    else onError(result.error);
  };
  return (
    <section aria-label="Differences" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">Differences at a hand-in</h3>
      <p className="text-xs text-fg-muted">When the cash counted is not what the rider held, a difference up to this size is recorded at once with its reason. A bigger one waits for a second person to approve it. A difference is written to the account you choose.</p>
      <Field id={`${uid}-limit`} label="Largest difference allowed without approval (KSh)">
        <input id={`${uid}-limit`} className={fieldClass} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} autoComplete="off" />
      </Field>
      <ChoicePicker label="Account a difference is written to" source="door-variance-accounts" choice={account} onChoice={setAccount} placeholder="Choose an account (for example cash over and short)" clearable />
      <button type="button" className={primaryClass} disabled={busy || Number.isNaN(Number(limit)) || limit.trim() === ''} onClick={() => void save()}>
        Save
      </button>
    </section>
  );
}

/** Counting a rider's cash in, in front of a witness: what they hold, what was counted, and where it goes. */
function HandInForm({ rider, onDone, onError }: { rider: CustodyRiderView; onDone: (view: HandInView) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState('');
  const [to, setTo] = useState<Choice | null>(null);
  const [witness, setWitness] = useState<Choice | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const typed = counted.trim() === '' ? null : Number(counted);
  const diff = typed === null || Number.isNaN(typed) ? null : handInCheck(toCents(rider.balance), toCents(typed), 0).diffCents;
  if (!open) {
    return (
      <button type="button" className={primaryClass} onClick={() => setOpen(true)} aria-label={`Record a hand-in from ${rider.name}`}>
        Record a hand-in
      </button>
    );
  }
  return (
    <form
      aria-label={`Hand-in from ${rider.name}`}
      className="space-y-3 rounded-lg border border-line bg-surface-raised p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void (async () => {
          setBusy(true);
          const r = await attempt(recordHandInAction({ riderId: rider.riderId, counted: typed, toBankAccountId: to?.id ?? '', witnessUserId: witness?.id ?? '', note }));
          setBusy(false);
          if (!r.ok) {
            onError(r.error);
            return;
          }
          setOpen(false);
          setCounted('');
          setNote('');
          onDone(r.data);
        })();
      }}
    >
      <p className="text-sm text-fg">
        {rider.name} is expected to hand in <strong>KSh {rider.balance}</strong>.
      </p>
      <Field id={`${uid}-counted`} label="Cash counted (KSh)">
        <input id={`${uid}-counted`} className={fieldClass} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} required autoComplete="off" />
      </Field>
      {diff === null || diff === 0 ? null : (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300">
          That is {diff < 0 ? 'short' : 'over'} by KSh {(Math.abs(diff) / 100).toFixed(2)}. Say why below.
        </p>
      )}
      <ChoicePicker label="Cash goes into" source="door-hand-in-accounts" choice={to} onChoice={setTo} placeholder="Choose the till or bank account" />
      <ChoicePicker label="Witness" source="door-hand-in-witnesses" choice={witness} onChoice={setWitness} placeholder="Who saw it counted" />
      <Field id={`${uid}-note`} label={diff === null || diff === 0 ? 'A note (optional)' : 'Why it is out'}>
        <input id={`${uid}-note`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoComplete="off" required={diff !== null && diff !== 0} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy || to === null || witness === null}>
          {busy ? 'Saving…' : 'Record the hand-in'}
        </button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function HandInRow({ h, canApprove, onDone, onError }: { h: HandInView; canApprove: boolean; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (kind: 'approve' | 'refuse'): Promise<void> => {
    setBusy(true);
    const r = kind === 'approve' ? await attempt(approveHandInAction({ handInId: h.id })) : await attempt(refuseHandInAction({ handInId: h.id, reason }));
    setBusy(false);
    if (!r.ok) onError(r.error);
    else onDone(kind === 'approve' ? `${h.number} is approved and posted.` : `${h.number} is not accepted.`);
  };
  return (
    <li className="space-y-2 rounded-xl border border-line bg-surface-raised p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-semibold text-fg-strong">
          {h.number} · {h.riderName}
        </span>
        <Chip tone={TONE[h.status]}>{HAND_IN_WORDS[h.status]}</Chip>
      </div>
      <p className="text-fg">
        Counted {h.currency} {h.counted} of {h.expected} · into {h.toAccount} · witnessed by {h.witnessName}
        {Number(h.difference) === 0 ? '' : ` · ${Number(h.difference) < 0 ? 'short' : 'over'} by ${h.difference.replace('-', '')}`}
      </p>
      <p className="text-xs text-fg-muted">
        {when(h.createdAt)}
        {h.note === null ? '' : ` · ${h.note}`}
        {h.decisionReason === null ? '' : ` · refused: ${h.decisionReason}`}
      </p>
      {h.status === 'pending_approval' && canApprove ? (
        <div className="space-y-2">
          <Field id={`${uid}-why`} label="Why it is refused (if you refuse it)">
            <input id={`${uid}-why`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void decide('approve')} aria-label={`Approve ${h.number}`}>
              Approve
            </button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void decide('refuse')} aria-label={`Refuse ${h.number}`}>
              Refuse
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function PayOnDeliveryPanel({ settings, onSaved, onError }: { settings: Settings; onSaved: (s: DoorSettingsView) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [on, setOn] = useState(settings.payOnDelivery);
  const [max, setMax] = useState(settings.payOnDeliveryMax ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const result = await attempt(setPayOnDeliveryAction({ enabled: on, max: max.trim() === '' ? null : Number(max), expectedVersion: settings.version }));
    setBusy(false);
    if (result.ok) onSaved(result.data);
    else onError(result.error);
  };
  return (
    <section aria-label="Pay on delivery" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">Pay on delivery at checkout</h3>
      <p className="text-xs text-fg-muted">
        Shoppers who choose delivery by your own riders can place the order now and pay the rider when it arrives, in cash or by M-Pesa. Their delivery is marked to be paid at the door for them. It needs cash at the door to be set up above.
      </p>
      <label htmlFor={`${uid}-on`} className="flex min-h-10 items-start gap-3">
        <input id={`${uid}-on`} type="checkbox" className="mt-1 h-5 w-5" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span className="text-sm font-semibold text-fg-strong">Let shoppers pay on delivery</span>
      </label>
      <Field id={`${uid}-max`} label="Largest order taken this way (KSh, empty for no limit)" hint="A larger order must be paid another way. Cash at a door is a risk you may want to limit.">
        <input id={`${uid}-max`} className={fieldClass} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} autoComplete="off" />
      </Field>
      <button type="button" className={primaryClass} disabled={busy || (on === settings.payOnDelivery && (max.trim() === '' ? null : max) === settings.payOnDeliveryMax)} onClick={() => void save()}>
        Save
      </button>
    </section>
  );
}
