'use client';

import { use, useEffect, useState } from 'react';
import { doorBalancesAction, doorEntriesAction, finishDoorPostingAction, setDoorCashMethodAction, type doorSettingsAction } from '@/server/domains/delivery/door-payment-actions';
import type { CustodyEntryView, CustodyRiderView } from '@/server/domains/delivery/door-payments';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
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
          setSettings(s);
          setNotice({ kind: 'ok', text: 'Saved. Cash taken at doors is received through this method from now on.' });
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

function MethodPanel({ settings, onSaved, onError }: { settings: Settings; onSaved: (s: Settings) => void; onError: (text: string) => void }) {
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
