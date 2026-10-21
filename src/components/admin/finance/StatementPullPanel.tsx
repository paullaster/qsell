'use client';

import { useId, useState } from 'react';
import {
  pullStatementAction,
  statementPullSetupAction,
} from '@/server/domains/finance/bank-statement-actions';
import { Field, LoadFailed, buttonClass, fieldClass, primaryClass, attempt } from './ui';

type Setup = Extract<Awaited<ReturnType<typeof statementPullSetupAction>>, { ok: true }>['data'];

const daysBefore = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Reads the account's statement from the bank through its API, for a range of days. Overlapping days are fine: a line the bank
 * sent before is kept once. The bank connection and the account number are set on the bank account.
 */
export function StatementPullPanel({
  bankAccountId,
  setup,
  onClose,
  onDone,
}: {
  bankAccountId: string;
  setup: Setup;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const uid = useId();
  const [from, setFrom] = useState(daysBefore(setup.today, 7));
  const [to, setTo] = useState(setup.today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pull = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await attempt(pullStatementAction(bankAccountId, { fromDate: from, toDate: to }));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const d = res.data;
    if (d.empty)
      onDone(`${setup.provider ?? 'The bank'} has no transactions for ${from} to ${to}.`);
    else if (d.lines === 0)
      onDone(
        `Nothing new: all ${String(d.duplicates)} line${d.duplicates === 1 ? ' was' : 's were'} already kept.`,
      );
    else
      onDone(
        `Kept ${String(d.lines)} new line${d.lines === 1 ? '' : 's'} (${String(d.duplicates)} already kept). ${String(d.autoMatched)} matched by themselves, ${String(d.proposed)} suggested.${d.truncated ? ' The bank had more than one pull can read: pull the remaining days again.' : ''}`,
      );
  };

  return (
    <form
      onSubmit={(e) => void pull(e)}
      className="space-y-3 rounded-xl border border-line bg-surface-raised p-4"
      aria-label="Pull the statement from the bank"
    >
      <p className="text-sm text-fg">
        Read the statement from {setup.provider ?? 'the bank'} for a range of days. Lines already
        kept are not added again, so overlapping days are fine.
      </p>
      {setup.ready ? null : (
        <p role="alert" className="text-sm text-red-700">
          {setup.provider === null
            ? 'This account is not connected to a bank yet. Choose the bank connection when you edit it (Finance → Bank accounts).'
            : 'This account has no account number, which the bank needs to find it. Add it when you edit the account (Finance → Bank accounts).'}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-f`} label="From (first day)">
          <input
            id={`${uid}-f`}
            type="date"
            max={setup.today}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={fieldClass}
            required
          />
        </Field>
        <Field id={`${uid}-t`} label="To (last day)">
          <input
            id={`${uid}-t`}
            type="date"
            max={setup.today}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={fieldClass}
            required
          />
        </Field>
      </div>
      {setup.last === null ? null : (
        <p className="text-xs text-fg-muted">
          Last pull: {new Date(setup.last.at).toLocaleString()}, {setup.last.from} to{' '}
          {setup.last.to}, {setup.last.lines} new lines.
        </p>
      )}
      {error === null ? null : <LoadFailed error={error} />}
      <div className="flex gap-2">
        <button type="submit" className={primaryClass} disabled={busy || !setup.ready}>
          {busy ? 'Reading…' : 'Pull the statement'}
        </button>
        <button type="button" className={buttonClass} onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
    </form>
  );
}
