'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  cashCountHistoryAction,
  cashCountPreviewAction,
  postCashCountAction,
  type cashCountsOverviewAction,
} from '@/server/domains/finance/cash-count-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { countedCents, countProblem, differenceWords, MAX_DENOMINATIONS } from '@/lib/cash-count';
import type { Choice } from '@/lib/payment-options';
import {
  Chip,
  Field,
  LoadFailed,
  Message,
  PageHeader,
  buttonClass,
  cardClass,
  fieldClass,
  money,
  primaryClass,
  type Notice,
  attempt,
} from './ui';

type View = Extract<Awaited<ReturnType<typeof cashCountsOverviewAction>>, { ok: true }>['data'];
type Account = View['accounts'][number];
type Preview = Extract<Awaited<ReturnType<typeof cashCountPreviewAction>>, { ok: true }>['data'];
type History = Extract<Awaited<ReturnType<typeof cashCountHistoryAction>>, { ok: true }>['data'];

export function CashCountsClient({
  viewPromise,
}: {
  viewPromise: ReturnType<typeof cashCountsOverviewAction>;
}) {
  const res = use(viewPromise);
  return res.ok ? <CashCountsView view={res.data} /> : <LoadFailed error={res.error} />;
}

function CashCountsView({ view }: { view: View }) {
  const [notice, setNotice] = useState<Notice>(null);
  const router = useRouter();
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Cash counts"
        intro="Count the cash in a drawer or safe against what the books say it holds. A difference is written to the books at once, with the reason, and every count is kept for good. A mistake is answered by counting again."
      />
      <Message notice={notice} />
      {view.accounts.length === 0 ? (
        <p className="text-sm text-fg-muted">
          There is no cash account to count. Add one under Finance → Bank accounts (kind: cash).
        </p>
      ) : null}
      <ul className="space-y-4">
        {view.accounts.map((a) => (
          <li key={a.id}>
            <AccountCard
              account={a}
              today={view.today}
              canCount={view.canCount}
              onDone={(text) => {
                setNotice({ kind: 'ok', text });
                router.refresh();
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How a past count came out, in a word or two. */
function lastWords(difference: string): string {
  const n = Number(difference);
  if (n === 0) return 'agreed';
  return n < 0 ? `short ${money(String(-n))}` : `over ${money(difference)}`;
}

/** The colour of a difference: red when short, green when over. */
function differenceTone(difference: string): string {
  const n = Number(difference);
  if (n === 0) return '';
  return n < 0 ? 'text-red-700' : 'text-green-700';
}

function AccountCard({
  account,
  today,
  canCount,
  onDone,
}: {
  account: Account;
  today: string;
  canCount: boolean;
  onDone: (text: string) => void;
}) {
  const [counting, setCounting] = useState<Preview | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The books' figure is read when the person asks to count, in the click, so the form opens with it.
  const openCount = async () => {
    if (counting !== null) {
      setCounting(null);
      return;
    }
    const res = await attempt(cashCountPreviewAction(account.id, today));
    if (res.ok) {
      setError(null);
      setCounting(res.data);
    } else setError(res.error);
  };

  const showHistory = async () => {
    const res = await attempt(cashCountHistoryAction(account.id));
    if (res.ok) setHistory(res.data);
    else setError(res.error);
  };
  const more = async () => {
    if (history?.next == null) return;
    const res = await attempt(cashCountHistoryAction(account.id, history.next));
    if (res.ok) setHistory({ next: res.data.next, rows: [...history.rows, ...res.data.rows] });
  };

  return (
    <section className={`${cardClass} space-y-3`} aria-label={`${account.code} ${account.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-fg-strong">
            {account.code} · {account.name}
          </h3>
          <p className="text-xs text-fg-muted">
            Books today:{' '}
            <b>
              {account.currency} {money(account.book)}
            </b>
          </p>
          {account.last === null ? (
            <p className="text-xs text-fg-muted">Never counted.</p>
          ) : (
            <p className="text-xs text-fg-muted">
              Last counted {account.last.date} ({account.last.number}): {account.currency}{' '}
              {money(account.last.counted)}, {lastWords(account.last.difference)}.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canCount ? (
            <button
              type="button"
              className={primaryClass}
              aria-expanded={counting !== null}
              onClick={() => void openCount()}
            >
              Count the cash
            </button>
          ) : null}
          <button
            type="button"
            className={buttonClass}
            aria-expanded={history !== null}
            onClick={() => (history === null ? void showHistory() : setHistory(null))}
          >
            Earlier counts
          </button>
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {counting !== null ? (
        <CountForm
          account={account}
          today={today}
          first={counting}
          onClose={() => setCounting(null)}
          onDone={(text) => {
            setCounting(null);
            setHistory(null);
            onDone(text);
          }}
        />
      ) : null}
      {history === null ? null : (
        <div className="space-y-2">
          {history.rows.length === 0 ? (
            <p className="text-sm text-fg-muted">No counts yet.</p>
          ) : null}
          {history.rows.length > 0 ? (
            <>
              <ul
                className="space-y-2 md:hidden"
                aria-label={`Counts of ${account.code}, newest first`}
              >
                {history.rows.map((r) => (
                  <li key={r.id} className="space-y-1 rounded-lg border border-line p-3 text-xs">
                    <p className="flex flex-wrap justify-between gap-2">
                      <span className="font-mono font-semibold">{r.number}</span>
                      <span className="text-fg-muted">{r.date}</span>
                    </p>
                    <p>
                      Counted {money(r.counted)} · books {money(r.expected)}
                    </p>
                    <p className={`font-semibold ${differenceTone(r.difference)}`}>
                      Difference {money(r.difference)}
                    </p>
                    {r.note === null ? null : <p className="break-words">{r.note}</p>}
                    <p className="text-fg-muted">{r.by}</p>
                  </li>
                ))}
              </ul>
              <table className="hidden w-full text-left text-xs md:table">
                <caption className="sr-only">Counts of {account.code}, newest first</caption>
                <thead className="text-fg-muted">
                  <tr>
                    <th scope="col" className="py-1 pr-3">
                      Count
                    </th>
                    <th scope="col" className="pr-3">
                      Date
                    </th>
                    <th scope="col" className="pr-3 text-right">
                      Counted
                    </th>
                    <th scope="col" className="pr-3 text-right">
                      Books
                    </th>
                    <th scope="col" className="pr-3 text-right">
                      Difference
                    </th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((r) => (
                    <tr key={r.id} className="border-t border-line align-top">
                      <td className="py-1.5 pr-3 font-mono">{r.number}</td>
                      <td className="pr-3 whitespace-nowrap">{r.date}</td>
                      <td className="pr-3 text-right tabular-nums">{money(r.counted)}</td>
                      <td className="pr-3 text-right tabular-nums">{money(r.expected)}</td>
                      <td
                        className={`pr-3 text-right tabular-nums ${differenceTone(r.difference)}`}
                      >
                        {money(r.difference)}
                      </td>
                      <td className="break-words">
                        {r.note ?? ''}
                        <span className="block text-fg-muted">{r.by}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {history.next === null ? null : (
            <button type="button" className={buttonClass} onClick={() => void more()}>
              Show more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface Row {
  key: number;
  value: string;
  count: string;
}

function CountForm({
  account,
  today,
  first,
  onClose,
  onDone,
}: {
  account: Account;
  today: string;
  first: Preview;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const uid = useId();
  const [date, setDate] = useState(today);
  const [byKind, setByKind] = useState(true);
  const [rows, setRows] = useState<Row[]>([{ key: 1, value: '', count: '' }]);
  const [nextKey, setNextKey] = useState(2);
  const [total, setTotal] = useState('');
  const [preview, setPreview] = useState<Preview | null>(first);
  const [variance, setVariance] = useState<Choice | null>(
    first.lastVariance === null
      ? null
      : { id: first.lastVariance.id, label: first.lastVariance.label },
  );
  const [cashGl, setCashGl] = useState<Choice | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (d: string) => {
    const res = await attempt(cashCountPreviewAction(account.id, d));
    if (res.ok) {
      setPreview(res.data);
      setError(null);
      setVariance(
        (v) =>
          v ??
          (res.data.lastVariance === null
            ? null
            : { id: res.data.lastVariance.id, label: res.data.lastVariance.label }),
      );
    } else setError(res.error);
  };
  const counted = countedCents(byKind, rows, total);
  const centsCounted = counted.ok ? counted.value : null;
  const diff = centsCounted === null || preview === null ? null : centsCounted - preview.bookCents;
  const problem = diff === null ? null : countProblem(diff, note, variance !== null);
  const needsGl = (preview?.glChoiceCount ?? 0) > 1 && diff !== null && diff !== 0;

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (diff === null) return;
    setBusy(true);
    setError(null);
    const res = await attempt(
      postCashCountAction({
        bankAccountId: account.id,
        countDate: date,
        ...(byKind
          ? { denominations: rows.map((r) => ({ value: r.value, count: r.count })) }
          : { total }),
        varianceGlAccountId: diff === 0 ? undefined : variance?.id,
        glAccountId: needsGl ? cashGl?.id : undefined,
        note: note.trim() === '' ? undefined : note.trim(),
      }),
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone(
      `Counted: ${res.data.number}. ${differenceWords(Math.round(Number(res.data.difference) * 100))}`,
    );
  };

  const setRow = (key: number, patch: Partial<Row>) =>
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded-lg border border-line p-3"
      aria-label={`Count ${account.code}`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-d`} label="Day counted">
          <input
            id={`${uid}-d`}
            type="date"
            max={today}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              if (e.target.value !== '') void load(e.target.value);
            }}
            className={fieldClass}
            required
          />
        </Field>
        <div className="flex items-end gap-2" role="group" aria-label="How to enter the count">
          <button
            type="button"
            className={buttonClass}
            aria-pressed={byKind}
            onClick={() => setByKind(true)}
          >
            Notes and coins
          </button>
          <button
            type="button"
            className={buttonClass}
            aria-pressed={!byKind}
            onClick={() => setByKind(false)}
          >
            Just the total
          </button>
        </div>
      </div>

      {byKind ? (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div
              key={r.key}
              role="group"
              aria-label={`Row ${String(i + 1)}`}
              className="grid grid-cols-[1fr_1fr_auto] items-end gap-3"
            >
              <Field id={`${uid}-v${String(r.key)}`} label="Value of one">
                <input
                  id={`${uid}-v${String(r.key)}`}
                  value={r.value}
                  onChange={(e) => setRow(r.key, { value: e.target.value })}
                  className={fieldClass}
                  inputMode="decimal"
                  autoComplete="off"
                />
              </Field>
              <Field id={`${uid}-c${String(r.key)}`} label="How many">
                <input
                  id={`${uid}-c${String(r.key)}`}
                  value={r.count}
                  onChange={(e) => setRow(r.key, { count: e.target.value })}
                  className={fieldClass}
                  inputMode="numeric"
                  autoComplete="off"
                />
              </Field>
              {rows.length > 1 ? (
                <button
                  type="button"
                  className={buttonClass}
                  aria-label={`Remove row ${String(i + 1)}`}
                  onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}
                >
                  Remove
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
          {rows.length < MAX_DENOMINATIONS ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setRows((all) => [...all, { key: nextKey, value: '', count: '' }]);
                setNextKey(nextKey + 1);
              }}
            >
              Add a kind of note or coin
            </button>
          ) : null}
        </div>
      ) : (
        <Field id={`${uid}-t`} label="Total counted">
          <input
            id={`${uid}-t`}
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            className={fieldClass}
            inputMode="decimal"
            autoComplete="off"
          />
        </Field>
      )}

      <div className="space-y-1 text-sm" aria-live="polite">
        <p>
          Counted:{' '}
          <b>
            {centsCounted === null
              ? '—'
              : `${account.currency} ${money((centsCounted / 100).toFixed(2))}`}
          </b>
        </p>
        <p>
          Books on {date}:{' '}
          <b>{preview === null ? '…' : `${preview.currency} ${money(preview.book)}`}</b>
        </p>
        {diff === null ? null : (
          <p className={diff === 0 ? 'text-green-700' : 'text-red-700'}>{differenceWords(diff)}</p>
        )}
        {!counted.ok &&
        (byKind ? rows.some((r) => r.value !== '' || r.count !== '') : total !== '') ? (
          <p className="text-red-700">{counted.error}</p>
        ) : null}
      </div>

      {diff !== null && diff !== 0 ? (
        <div className="space-y-3">
          <ChoicePicker
            label="Write the difference to"
            source="cash-variance-accounts"
            choice={variance}
            onChoice={setVariance}
            clearable={false}
            required
            placeholder="Which account?"
          />
          {needsGl ? (
            <ChoicePicker
              label="Cash G/L account"
              source="cash-count-gl-accounts"
              filters={{ account: account.id }}
              choice={cashGl}
              onChoice={setCashGl}
              clearable={false}
              required
              placeholder="Which G/L account?"
            />
          ) : null}
          <Field
            id={`${uid}-n`}
            label="Why does it not agree?"
            hint="Kept with your name and the time."
          >
            <input
              id={`${uid}-n`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={fieldClass}
              maxLength={300}
              autoComplete="off"
              required
            />
          </Field>
        </div>
      ) : null}

      {problem === null ? null : <p className="text-xs text-fg-muted">{problem}</p>}
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className={primaryClass}
          disabled={busy || diff === null || problem !== null || (needsGl && cashGl === null)}
        >
          Record the count
        </button>
        <button type="button" className={buttonClass} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {diff === 0 ? <Chip tone="green">Agrees</Chip> : null}
      </div>
    </form>
  );
}
